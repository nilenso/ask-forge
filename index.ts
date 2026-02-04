import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import {
	type AskOptions,
	type AskResult,
	createSession,
	type Forge,
	type OnProgress,
	type ProgressEvent,
	type Repo,
	type Session,
	type ToolCallRecord,
} from "./session";

// Git environment to prevent interactive prompts and SSH key loading
const GIT_ENV: Record<string, string> = {
	// Disable SSH agent and key loading
	SSH_AUTH_SOCK: "",
	// Use a non-existent SSH key to prevent loading default keys
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	// Disable terminal prompts for credentials
	GIT_TERMINAL_PROMPT: "0",
	// Disable askpass programs
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	// Preserve PATH for git to work
	PATH: process.env.PATH || "",
};

// Lock map to prevent race conditions when cloning the same repo in parallel
const cloneLocks = new Map<string, Promise<void>>();

async function withCloneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	while (cloneLocks.has(key)) {
		await cloneLocks.get(key);
	}

	let resolveLock: (() => void) | undefined;
	const lockPromise = new Promise<void>((r) => {
		resolveLock = r;
	});
	cloneLocks.set(key, lockPromise);

	try {
		return await fn();
	} finally {
		cloneLocks.delete(key);
		resolveLock?.();
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function commitishExistsLocally(repoPath: string, commitish: string): Promise<boolean> {
	const proc = Bun.spawn(["git", "cat-file", "-t", commitish], {
		cwd: repoPath,
		stdout: "pipe",
		stderr: "pipe",
		env: GIT_ENV,
	});
	const output = (await new Response(proc.stdout).text()).trim();
	const exitCode = await proc.exited;
	return exitCode === 0 && (output === "commit" || output === "tag");
}

export type ForgeName = "github" | "gitlab";

const GitHubForge: Forge = {
	name: "github",
	buildCloneUrl(repoUrl: string, token?: string): string {
		if (!token) return repoUrl;
		const url = new URL(repoUrl);
		url.username = token;
		return url.toString();
	},
};

const GitLabForge: Forge = {
	name: "gitlab",
	buildCloneUrl(repoUrl: string, token?: string): string {
		if (!token) return repoUrl;
		const url = new URL(repoUrl);
		url.username = "oauth2";
		url.password = token;
		return url.toString();
	},
};

const forges: Record<ForgeName, Forge> = {
	github: GitHubForge,
	gitlab: GitLabForge,
};

function inferForge(repoUrl: string): ForgeName | null {
	const url = new URL(repoUrl);
	if (url.hostname === "github.com") return "github";
	if (url.hostname === "gitlab.com") return "gitlab";
	return null;
}

function parseRepoPath(repoUrl: string): { username: string; reponame: string } {
	const url = new URL(repoUrl);
	const parts = url.pathname
		.replace(/^\//, "")
		.replace(/\.git$/, "")
		.split("/");
	if (parts.length < 2 || !parts[0] || !parts[1]) {
		throw new Error(`Invalid repo URL: ${repoUrl}`);
	}
	return { username: parts[0], reponame: parts[1] };
}

export interface ConnectOptions {
	token?: string;
	forge?: ForgeName;
	commitish?: string;
}

async function connectRepo(repoUrl: string, options: ConnectOptions = {}): Promise<Repo> {
	const forgeName = options.forge ?? inferForge(repoUrl);
	if (!forgeName) {
		throw new Error(`Cannot infer forge from URL: ${repoUrl}. Please specify 'forge' option.`);
	}

	const forge = forges[forgeName];
	const { username, reponame } = parseRepoPath(repoUrl);
	const basePath = join(homedir(), ".ask-forge", "repos", username, reponame);
	const cachePath = join(basePath, "repo");
	const commitish = options.commitish ?? "HEAD";

	await withCloneLock(cachePath, async () => {
		// Check if bare repo exists (bare repos have HEAD directly in the directory)
		const headFile = join(cachePath, "HEAD");
		if (await exists(headFile)) {
			// Valid bare repo exists - fetch if needed
			const hasCommitish = await commitishExistsLocally(cachePath, commitish);
			if (!hasCommitish) {
				const proc = Bun.spawn(["git", "fetch", "origin", "--tags"], {
					cwd: cachePath,
					stdout: "inherit",
					stderr: "inherit",
					env: GIT_ENV,
				});
				await proc.exited;
			}
		} else {
			// Clean up incomplete clone if directory exists but HEAD doesn't
			if (await exists(cachePath)) {
				const { rm } = await import("node:fs/promises");
				await rm(cachePath, { recursive: true, force: true });
			}
			await mkdir(cachePath, { recursive: true });
			const cloneUrl = forge.buildCloneUrl(repoUrl, options.token);
			const proc = Bun.spawn(["git", "clone", "--bare", cloneUrl, cachePath], {
				stdout: "inherit",
				stderr: "inherit",
				env: GIT_ENV,
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				throw new Error(`git clone failed with exit code ${exitCode}`);
			}
		}
	});

	const revParseProc = Bun.spawn(["git", "rev-parse", commitish], {
		cwd: cachePath,
		stdout: "pipe",
		stderr: "pipe",
		env: GIT_ENV,
	});
	const sha = (await new Response(revParseProc.stdout).text()).trim();
	const revParseExit = await revParseProc.exited;
	if (revParseExit !== 0) {
		throw new Error(`Failed to resolve commitish: ${commitish}`);
	}

	const shortSha = sha.slice(0, 12);
	const worktreePath = resolve(basePath, "trees", shortSha);

	if (await exists(worktreePath)) {
		return {
			url: repoUrl,
			localPath: worktreePath,
			forge,
			commitish: sha,
			cachePath: resolve(cachePath),
		};
	}

	await mkdir(resolve(basePath, "trees"), { recursive: true });
	const worktreeProc = Bun.spawn(["git", "worktree", "add", worktreePath, sha], {
		cwd: cachePath,
		stdout: "inherit",
		stderr: "inherit",
		env: GIT_ENV,
	});
	const worktreeExit = await worktreeProc.exited;
	if (worktreeExit !== 0) {
		throw new Error(`git worktree add failed with exit code ${worktreeExit}`);
	}

	return {
		url: repoUrl,
		localPath: worktreePath,
		forge,
		commitish: sha,
		cachePath: resolve(cachePath),
	};
}

// Re-export types from session
export type { AskOptions, AskResult, Forge, Message, OnProgress, ProgressEvent, Repo, Session, ToolCallRecord };

/**
 * Connect to a repository and create a session
 * @param repoUrl - The URL of the repository to connect to
 * @param options - Connection options (token, forge override, commitish)
 * @returns A Session for asking questions about the repository
 */
export async function connect(repoUrl: string, options: ConnectOptions = {}): Promise<Session> {
	const repo = await connectRepo(repoUrl, options);
	return createSession(repo);
}
