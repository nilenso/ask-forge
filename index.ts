import { access, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Context, complete, getModel, type Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import * as config from "./config";

// Lock map to prevent race conditions when cloning the same repo in parallel
const cloneLocks = new Map<string, Promise<void>>();

async function withCloneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	// Wait for any existing operation on this key
	while (cloneLocks.has(key)) {
		await cloneLocks.get(key);
	}

	// Create a new lock
	let resolve: (() => void) | undefined;
	const lockPromise = new Promise<void>((r) => {
		resolve = r;
	});
	cloneLocks.set(key, lockPromise);

	try {
		return await fn();
	} finally {
		cloneLocks.delete(key);
		resolve?.();
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
	});
	const output = (await new Response(proc.stdout).text()).trim();
	const exitCode = await proc.exited;
	return exitCode === 0 && (output === "commit" || output === "tag");
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

function parseRepoPath(repoUrl: string): {
	username: string;
	reponame: string;
} {
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
	commitish?: string;
}

export interface Repo {
	url: string;
	localPath: string;
	forge: Forge;
	commitish: string;
	cachePath: string;
}

/**
 * Connect to a repository by cloning it locally and creating a worktree
 * @param repoUrl - The URL of the repository to connect to
 * @param options - Connection options (token, forge override, commitish)
 * @returns A Repo object representing the connected repository
 */
export async function connect(repoUrl: string, options: ConnectOptions = {}): Promise<Repo> {
	const forgeName = options.forge ?? inferForge(repoUrl);
	if (!forgeName) {
		throw new Error(`Cannot infer forge from URL: ${repoUrl}. Please specify 'forge' option.`);
	}

	const forge = forges[forgeName];
	const { username, reponame } = parseRepoPath(repoUrl);
	const basePath = join("workdir", username, reponame);
	const cachePath = join(basePath, "repo");
	const commitish = options.commitish ?? "HEAD";

	// Use lock to prevent race conditions when multiple connects target the same repo
	await withCloneLock(cachePath, async () => {
		// Check if cache repo already exists
		const gitDir = join(cachePath, ".git");
		if (await exists(gitDir)) {
			// Check if commitish exists locally
			const hasCommitish = await commitishExistsLocally(cachePath, commitish);
			if (!hasCommitish) {
				// Fetch from origin to get the commitish
				const proc = Bun.spawn(["git", "fetch", "origin", "--tags"], {
					cwd: cachePath,
					stdout: "inherit",
					stderr: "inherit",
				});
				await proc.exited;
			}
		} else {
			// Clone the repo to cache
			await mkdir(cachePath, { recursive: true });

			const cloneUrl = forge.buildCloneUrl(repoUrl, options.token);
			const proc = Bun.spawn(["git", "clone", cloneUrl, cachePath], {
				stdout: "inherit",
				stderr: "inherit",
			});
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				throw new Error(`git clone failed with exit code ${exitCode}`);
			}
		}
	});

	// Resolve commitish to a full SHA for worktree directory name
	const revParseProc = Bun.spawn(["git", "rev-parse", commitish], {
		cwd: cachePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const sha = (await new Response(revParseProc.stdout).text()).trim();
	const revParseExit = await revParseProc.exited;
	if (revParseExit !== 0) {
		throw new Error(`Failed to resolve commitish: ${commitish}`);
	}

	// Create worktree path using short SHA (absolute path for git worktree)
	const shortSha = sha.slice(0, 12);
	const worktreePath = resolve(basePath, "trees", shortSha);

	// Check if worktree already exists
	if (await exists(worktreePath)) {
		return {
			url: repoUrl,
			localPath: worktreePath,
			forge,
			commitish: sha,
			cachePath: resolve(cachePath),
		};
	}

	// Create the worktree
	await mkdir(resolve(basePath, "trees"), { recursive: true });
	const worktreeProc = Bun.spawn(["git", "worktree", "add", worktreePath, sha], {
		cwd: cachePath,
		stdout: "inherit",
		stderr: "inherit",
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

const tools: Tool[] = [
	{
		name: "rg",
		description:
			"Search for a pattern in files using ripgrep. Returns matching lines with file paths and line numbers.",
		parameters: Type.Object({
			pattern: Type.String({ description: "The regex pattern to search for" }),
			glob: Type.Optional(
				Type.String({
					description: "File glob pattern to filter files (e.g., '*.ts', '**/*.json')",
				}),
			),
		}),
	},
	{
		name: "fd",
		description: "Find files by name pattern using fd. Returns matching file paths.",
		parameters: Type.Object({
			pattern: Type.String({
				description: "The pattern to match file names against",
			}),
			type: Type.Optional(
				Type.Union([Type.Literal("f"), Type.Literal("d")], {
					description: "Filter by type: 'f' for files, 'd' for directories",
				}),
			),
		}),
	},
	{
		name: "ls",
		description: "List files and directories in a given path.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "Path to list, relative to repository root. Defaults to root if not specified.",
				}),
			),
		}),
	},
	{
		name: "read",
		description: "Read the contents of a file.",
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file, relative to repository root",
			}),
		}),
	},
];

async function runCommand(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, {
		cwd,
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

async function executeTool(toolName: string, args: Record<string, unknown>, repoPath: string): Promise<string> {
	if (toolName === "rg") {
		const pattern = args.pattern as string;
		const glob = args.glob as string | undefined;
		const cmd = ["rg", "--line-number", pattern];
		if (glob) {
			cmd.push("--glob", glob);
		}
		return runCommand(cmd, repoPath);
	}

	if (toolName === "fd") {
		const pattern = args.pattern as string;
		const type = args.type as "f" | "d" | undefined;
		// Use find instead of fd for compatibility
		const cmd = ["find", ".", "-name", `*${pattern}*`];
		if (type === "f") {
			cmd.push("-type", "f");
		} else if (type === "d") {
			cmd.push("-type", "d");
		}
		return runCommand(cmd, repoPath);
	}

	if (toolName === "ls") {
		const path = (args.path as string | undefined) || ".";
		return runCommand(["ls", "-la", path], repoPath);
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

export interface ToolCallRecord {
	name: string;
	arguments: Record<string, unknown>;
}

export interface AskResult {
	prompt: string;
	"tool-calls": ToolCallRecord[];
	response: string;
}

/**
 * Ask a question about the repository
 * @param repo - The connected repository
 * @param queryString - The question to ask (e.g., "Do we have authentication enabled?")
 * @returns Structured result with prompt, tool-calls, and response
 */
export async function ask(repo: Repo, queryString: string): Promise<AskResult> {
	const model = getModel(config.MODEL_PROVIDER, config.MODEL_NAME);
	const toolCallRecords: ToolCallRecord[] = [];

	const context: Context = {
		systemPrompt: config.SYSTEM_PROMPT,
		messages: [{ role: "user", content: queryString }],
		tools,
	};

	const log = (label: string, content: string) => {
		console.log(`\n${"─".repeat(60)}`);
		console.log(`│ ${label}`);
		console.log(`${"─".repeat(60)}`);
		console.log(content);
	};

	const logError = (label: string, error: unknown) => {
		console.error(`\n${"═".repeat(60)}`);
		console.error(`│ ERROR: ${label}`);
		console.error(`${"═".repeat(60)}`);
		if (error instanceof Error) {
			console.error(`Message: ${error.message}`);
			if (error.cause) {
				console.error(`Cause: ${JSON.stringify(error.cause, null, 2)}`);
			}
			if (error.stack) {
				console.error(`Stack: ${error.stack}`);
			}
		} else {
			console.error(JSON.stringify(error, null, 2));
		}
		console.error(`${"═".repeat(60)}\n`);
	};

	for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
		let response: Awaited<ReturnType<typeof complete>>;
		try {
			response = await complete(model, context);
		} catch (error) {
			logError(`API call failed (iteration ${i + 1})`, error);
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				prompt: queryString,
				"tool-calls": toolCallRecords,
				response: `[ERROR: API call failed: ${errorMessage}]`,
			};
		}
		// Check for API error in response
		const apiResponse = response as { stopReason?: string; errorMessage?: string };
		if (apiResponse.stopReason === "error" || apiResponse.errorMessage) {
			const errorMsg = apiResponse.errorMessage || "Unknown API error";
			console.error(`\n${"═".repeat(60)}`);
			console.error("│ API ERROR");
			console.error(`${"═".repeat(60)}`);
			console.error(`Stop Reason: ${apiResponse.stopReason}`);
			console.error(`Error Message: ${errorMsg}`);
			console.error(`${"═".repeat(60)}\n`);
			return {
				prompt: queryString,
				"tool-calls": toolCallRecords,
				response: `[ERROR: ${errorMsg}]`,
			};
		}

		context.messages.push(response);

		const toolCalls = response.content.filter((b) => b.type === "toolCall");

		if (toolCalls.length === 0) {
			// No tool calls, extract text response
			const textBlocks = response.content.filter((b) => b.type === "text");
			const responseText = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n");

			// Check for empty response which may indicate an API error
			if (!responseText.trim()) {
				console.error(`\n${"═".repeat(60)}`);
				console.error("│ WARNING: Empty response from API");
				console.error(`${"═".repeat(60)}`);
				console.error("Full response:", JSON.stringify(response, null, 2));
				console.error(`${"═".repeat(60)}\n`);
				return {
					prompt: queryString,
					"tool-calls": toolCallRecords,
					response: "[ERROR: Empty response from API - check API key and credits]",
				};
			}

			log("RESPONSE", "");
			return {
				prompt: queryString,
				"tool-calls": toolCallRecords,
				response: responseText,
			};
		}

		// Execute tool calls and add results
		for (const call of toolCalls) {
			if (call.type !== "toolCall") continue;

			log(`TOOL: ${call.name}`, JSON.stringify(call.arguments, null, 2));
			const result = await executeTool(call.name, call.arguments, repo.localPath);

			toolCallRecords.push({
				name: call.name,
				arguments: call.arguments,
			});
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

	return {
		prompt: queryString,
		"tool-calls": toolCallRecords,
		response: "[ERROR: Max iterations reached without a final answer.]",
	};
}
