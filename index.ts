import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, complete, getModel, type Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

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

	// Check if repo already exists (has .git directory)
	const gitDir = join(localPath, ".git");
	if (await exists(gitDir)) {
		// Repo already cloned, optionally pull latest
		const proc = Bun.spawn(["git", "pull"], {
			cwd: localPath,
			stdout: "inherit",
			stderr: "inherit",
		});
		await proc.exited;
	} else {
		// Clone the repo
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
	}

	return {
		url: repoUrl,
		localPath,
		forge,
	};
}

const tools: Tool[] = [
	{
		name: "bash",
		description:
			"Execute a bash command in the repository directory. Available tools: ripgrep (rg), fd, cat, ls, grep, etc.",
		parameters: Type.Object({
			command: Type.String({ description: "The bash command to execute" }),
		}),
	},
	{
		name: "read",
		description: "Read the contents of a file",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file, relative to repository root" }),
		}),
	},
];

async function executeTool(toolName: string, args: Record<string, unknown>, repoPath: string): Promise<string> {
	if (toolName === "bash") {
		const command = args.command as string;
		const proc = Bun.spawn(["bash", "-c", command], {
			cwd: repoPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return `Error (exit ${exitCode}):\n${stderr}`;
		}
		return stdout || "(no output)";
	}

	if (toolName === "read") {
		const filePath = args.path as string;
		const fullPath = join(repoPath, filePath);
		try {
			return await readFile(fullPath, "utf-8");
		} catch (e) {
			return `Error reading file: ${(e as Error).message}`;
		}
	}

	return `Unknown tool: ${toolName}`;
}

/**
 * Ask a question about the repository
 * @param repo - The connected repository
 * @param queryString - The question to ask (e.g., "Do we have authentication enabled?")
 * @returns The answer to the query
 */
export async function ask(repo: Repo, queryString: string): Promise<string> {
	const model = getModel("anthropic", "claude-sonnet-4-20250514");

	const context: Context = {
		systemPrompt: `You are a code analysis assistant. You have access to a repository cloned at the current working directory.
Use the available tools to explore the codebase and answer the user's question.
Be concise and specific in your answers. Cite file paths when relevant.`,
		messages: [{ role: "user", content: queryString }],
		tools,
	};

	const maxIterations = 10;
	for (let i = 0; i < maxIterations; i++) {
		const response = await complete(model, context);
		context.messages.push(response);

		const toolCalls = response.content.filter((b) => b.type === "toolCall");

		if (toolCalls.length === 0) {
			// No tool calls, extract text response
			const textBlocks = response.content.filter((b) => b.type === "text");
			return textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n");
		}

		// Execute tool calls and add results
		for (const call of toolCalls) {
			if (call.type !== "toolCall") continue;
			const result = await executeTool(call.name, call.arguments, repo.localPath);
			context.messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: result }],
				isError: false,
				timestamp: Date.now(),
			});
		}
	}

	return "Max iterations reached without a final answer.";
}
