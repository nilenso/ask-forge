import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type ForgeName = "github" | "gitlab";

export interface Forge {
	name: ForgeName;
	buildCloneUrl(repoUrl: string, token?: string): string;
}

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
	if (parts.length < 2) {
		throw new Error(`Invalid repo URL: ${repoUrl}`);
	}
	return { username: parts[0], reponame: parts[1] };
}

export interface ConnectOptions {
	token?: string;
	forge?: ForgeName;
}

export interface Repo {
	url: string;
	localPath: string;
	forge: Forge;
}

/**
 * Connect to a repository by cloning it locally
 * @param repoUrl - The URL of the repository to connect to
 * @param options - Connection options (token, forge override)
 * @returns A Repo object representing the connected repository
 */
export async function connect(repoUrl: string, options: ConnectOptions = {}): Promise<Repo> {
	const forgeName = options.forge ?? inferForge(repoUrl);
	if (!forgeName) {
		throw new Error(`Cannot infer forge from URL: ${repoUrl}. Please specify 'forge' option.`);
	}

	const forge = forges[forgeName];
	const { username, reponame } = parseRepoPath(repoUrl);
	const localPath = join("workdir", username, reponame);

	await mkdir(localPath, { recursive: true });

	const cloneUrl = forge.buildCloneUrl(repoUrl, options.token);
	const proc = Bun.spawn(["git", "clone", cloneUrl, localPath], {
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		throw new Error(`git clone failed with exit code ${exitCode}`);
	}

	return {
		url: repoUrl,
		localPath,
		forge,
	};
}

/**
 * Ask a question about the repository
 * @param repo - The connected repository
 * @param queryString - The question to ask (e.g., "Do we have authentication enabled?")
 * @returns The answer to the query
 */
export async function ask(repo: Repo, queryString: string): Promise<string> {
	// TODO: Implement actual query processing using sandbox runtime and pi-ai
	return `[STUB] Query "${queryString}" for repo ${repo.url} at ${repo.localPath}`;
}
