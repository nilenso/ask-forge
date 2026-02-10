/**
 * Sandbox worker — HTTP server for isolated git and tool operations.
 *
 * Endpoints:
 *   POST /clone   { url, commitish? }  → clone a repo, check out a commit
 *   POST /tool    { slug, sha, name, args }  → execute a tool (rg, fd, ls, read, git)
 *   GET  /health                       → liveness check
 *   POST /reset                        → delete all cloned data
 *
 * Security is provided by the isolation module (see ./isolation/).
 */

import { resolve } from "node:path";
import { isolatedGitCommand, isolatedGitToolCommand, isolatedToolCommand } from "./isolation";

const PORT = Number(process.env.PORT) || 8080;
const REPO_BASE = "/home/forge/repos";
const SANDBOX_SECRET = process.env.SANDBOX_SECRET || "";

// =============================================================================
// Helpers
// =============================================================================

// Git environment to prevent interactive prompts
const GIT_ENV: Record<string, string> = {
	SSH_AUTH_SOCK: "",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	HOME: "/home/forge",
};

/** Default timeout for tool execution (30 seconds) */
const TOOL_TIMEOUT_MS = 30_000;
/** Default timeout for git operations (120 seconds) */
const GIT_TIMEOUT_MS = 120_000;

async function run(
	cmd: string[],
	cwd?: string,
	env?: Record<string, string>,
	timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: env ?? process.env,
	});

	if (timeoutMs) {
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				/* already exited */
			}
		}, timeoutMs);

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		clearTimeout(timer);

		if (exitCode === 137 || exitCode === -1) {
			return { stdout, stderr: `${stderr}\nOperation timed out after ${timeoutMs}ms`, exitCode: 124 };
		}
		return { stdout, stderr, exitCode };
	}

	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { stdout, stderr, exitCode: await proc.exited };
}

function repoDir(id: string): string {
	return `${REPO_BASE}/${id}`;
}

/** Turn a repo URL into a safe filesystem slug. */
function slugify(url: string): string {
	try {
		const u = new URL(url);
		return `${u.hostname}${u.pathname}`.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
	} catch {
		return url.replace(/[^a-zA-Z0-9._-]/g, "_");
	}
}

/** Validate path stays within worktree root. */
function validatePath(worktree: string, userPath: string): string | null {
	const full = resolve(worktree, userPath);
	if (!full.startsWith(resolve(worktree))) {
		return null;
	}
	return full;
}

/** Run a git command with filesystem + PID isolation. */
async function runGitIsolated(
	gitArgs: string[],
	cwd: string | undefined,
	repoBaseDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return run(
		isolatedGitCommand(gitArgs, repoBaseDir),
		cwd,
		{ ...GIT_ENV, GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_NOSYSTEM: "1" },
		GIT_TIMEOUT_MS,
	);
}

/** Run a tool command with filesystem, PID, and network isolation. */
async function runToolIsolated(
	cmd: string[],
	worktree: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return run(isolatedToolCommand(cmd, worktree, REPO_BASE), worktree, undefined, TOOL_TIMEOUT_MS);
}

// =============================================================================
// Clone
// =============================================================================

interface CloneRequest {
	url: string;
	commitish?: string;
}

async function handleClone(body: CloneRequest): Promise<Response> {
	const { url, commitish = "HEAD" } = body;
	if (!url) {
		return Response.json({ ok: false, error: "url is required" }, { status: 400 });
	}

	const slug = slugify(url);
	const baseDir = repoDir(slug);
	const bareDir = `${baseDir}/bare`;
	const treesDir = `${baseDir}/trees`;

	try {
		// Ensure directories exist (run outside bwrap — bwrap needs them to exist for bind mounts)
		await Bun.spawn(["mkdir", "-p", bareDir, treesDir]).exited;

		// Clone or fetch
		const headFile = Bun.file(`${bareDir}/HEAD`);
		if (await headFile.exists()) {
			const { exitCode, stderr } = await runGitIsolated(["fetch", "origin", "--tags"], bareDir, baseDir);
			if (exitCode !== 0) {
				console.error(`[clone] fetch failed: ${stderr}`);
			}
		} else {
			const { exitCode, stderr } = await runGitIsolated(["clone", "--bare", url, bareDir], undefined, baseDir);
			if (exitCode !== 0) {
				return Response.json({ ok: false, error: `git clone failed: ${stderr.slice(0, 500)}` }, { status: 500 });
			}
		}

		// Resolve commitish → SHA
		const revParse = await runGitIsolated(["rev-parse", commitish], bareDir, baseDir);
		if (revParse.exitCode !== 0) {
			return Response.json(
				{
					ok: false,
					error: `Cannot resolve commitish "${commitish}": ${revParse.stderr.slice(0, 300)}`,
				},
				{ status: 400 },
			);
		}
		const sha = revParse.stdout.trim();
		const shortSha = sha.slice(0, 12);
		const worktree = `${treesDir}/${shortSha}`;

		// Create worktree if it doesn't exist
		const worktreeExists = await Bun.file(`${worktree}/.git`).exists();
		if (!worktreeExists) {
			const wt = await runGitIsolated(["worktree", "add", worktree, sha], bareDir, baseDir);
			if (wt.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `git worktree add failed: ${wt.stderr.slice(0, 300)}` },
					{ status: 500 },
				);
			}
		}

		return Response.json({ ok: true, slug, sha, worktree });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ ok: false, error: msg }, { status: 500 });
	}
}

// =============================================================================
// Tool execution
// =============================================================================

interface ToolRequest {
	slug: string;
	sha: string;
	name: string;
	args: Record<string, unknown>;
}

async function handleTool(body: ToolRequest): Promise<Response> {
	const { slug, sha, name, args } = body;
	if (!slug || !sha || !name) {
		return Response.json({ ok: false, error: "slug, sha, and name are required" }, { status: 400 });
	}

	const shortSha = sha.slice(0, 12);
	const worktree = `${repoDir(slug)}/trees/${shortSha}`;
	const wtExists = await Bun.file(`${worktree}/.git`).exists();
	if (!wtExists) {
		return Response.json({ ok: false, error: `Worktree not found: ${worktree}` }, { status: 404 });
	}

	switch (name) {
		case "rg": {
			const pattern = args.pattern as string;
			const glob = args.glob as string | undefined;
			const cmd = ["rg", "--line-number", pattern];
			if (glob) cmd.push("--glob", glob);
			const result = await runToolIsolated(cmd, worktree);
			if (result.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `rg failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "find": {
			const pattern = args.pattern as string;
			const type = args.type as "f" | "d" | undefined;
			const cmd = ["find", ".", "-name", `*${pattern}*`];
			if (type === "f") cmd.push("-type", "f");
			else if (type === "d") cmd.push("-type", "d");
			const result = await runToolIsolated(cmd, worktree);
			if (result.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `find failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "ls": {
			const path = (args.path as string) || ".";
			const fullPath = validatePath(worktree, path);
			if (!fullPath) {
				return Response.json({ ok: false, error: `path traversal not allowed: ${path}` }, { status: 400 });
			}
			const result = await runToolIsolated(["ls", "-la", fullPath], worktree);
			if (result.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `ls failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "read": {
			const path = args.path as string;
			const fullPath = validatePath(worktree, path);
			if (!fullPath) {
				return Response.json({ ok: false, error: `path traversal not allowed: ${path}` }, { status: 400 });
			}
			const result = await runToolIsolated(["cat", fullPath], worktree);
			if (result.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `read failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(empty file)" });
		}
		case "git": {
			// Read-only git commands (log, show, blame, diff, etc.)
			const subcommand = args.command as string;
			const gitArgs = (args.args as string[]) || [];

			// Allowlist of read-only git subcommands
			const allowedCommands = [
				"log",
				"show",
				"blame",
				"diff",
				"shortlog",
				"describe",
				"rev-parse",
				"ls-tree",
				"cat-file",
			];
			if (!allowedCommands.includes(subcommand)) {
				return Response.json(
					{ ok: false, error: `git subcommand not allowed: ${subcommand}. Allowed: ${allowedCommands.join(", ")}` },
					{ status: 400 },
				);
			}

			// Validate any path arguments don't escape worktree
			for (const arg of gitArgs) {
				if (arg.startsWith("-")) continue; // Skip flags
				if (arg.includes("..")) {
					return Response.json({ ok: false, error: `path traversal not allowed in args` }, { status: 400 });
				}
			}

			// Git worktrees need access to bare repo for .git references
			const bareRepo = `${repoDir(slug)}/bare`;
			const cmd = isolatedGitToolCommand(["git", subcommand, ...gitArgs], worktree, bareRepo, REPO_BASE);
			const result = await run(cmd, worktree, undefined, TOOL_TIMEOUT_MS);
			if (result.exitCode !== 0 && result.stderr) {
				return Response.json(
					{ ok: false, error: `git ${subcommand} failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		default:
			return Response.json({ ok: false, error: `Unknown tool: ${name}` }, { status: 400 });
	}
}

// =============================================================================
// Reset (delete all repos)
// =============================================================================

async function handleReset(): Promise<Response> {
	const { exitCode } = await run(["rm", "-rf", REPO_BASE]);
	if (exitCode !== 0) {
		return Response.json({ ok: false, error: "Failed to clean repos" }, { status: 500 });
	}
	await Bun.spawn(["mkdir", "-p", REPO_BASE]).exited;
	return Response.json({ ok: true });
}

// =============================================================================
// HTTP Server
// =============================================================================

await Bun.spawn(["mkdir", "-p", REPO_BASE]).exited;

function checkAuth(req: Request): Response | null {
	if (!SANDBOX_SECRET) return null; // No secret configured = no auth required
	const token = req.headers.get("Authorization")?.replace("Bearer ", "");
	if (token !== SANDBOX_SECRET) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}
	return null;
}

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		// Health check is unauthenticated (needed for Docker healthcheck)
		if (url.pathname === "/health" && req.method === "GET") {
			return Response.json({ ok: true });
		}

		// All other endpoints require auth
		const authError = checkAuth(req);
		if (authError) return authError;

		if (url.pathname === "/clone" && req.method === "POST") {
			const body = (await req.json()) as CloneRequest;
			return handleClone(body);
		}

		if (url.pathname === "/tool" && req.method === "POST") {
			const body = (await req.json()) as ToolRequest;
			return handleTool(body);
		}

		if (url.pathname === "/reset" && req.method === "POST") {
			return handleReset();
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`[sandbox-worker] Listening on :${server.port}`);
