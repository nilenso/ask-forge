import { randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type AssistantMessage, type Context, getModel, stream, type Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import * as config from "./config";

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

export interface Repo {
	url: string;
	localPath: string;
	forge: Forge;
	commitish: string;
	cachePath: string;
}

async function connectRepo(repoUrl: string, options: ConnectOptions = {}): Promise<Repo> {
	const forgeName = options.forge ?? inferForge(repoUrl);
	if (!forgeName) {
		throw new Error(`Cannot infer forge from URL: ${repoUrl}. Please specify 'forge' option.`);
	}

	const forge = forges[forgeName];
	const { username, reponame } = parseRepoPath(repoUrl);
	const basePath = join("workdir", username, reponame);
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
			pattern: Type.String({ description: "The pattern to match file names against" }),
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
			path: Type.String({ description: "Path to the file, relative to repository root" }),
		}),
	},
];

async function runCommand(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
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
		if (glob) cmd.push("--glob", glob);
		return runCommand(cmd, repoPath);
	}

	if (toolName === "fd") {
		const pattern = args.pattern as string;
		const type = args.type as "f" | "d" | undefined;
		const cmd = ["find", ".", "-name", `*${pattern}*`];
		if (type === "f") cmd.push("-type", "f");
		else if (type === "d") cmd.push("-type", "d");
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
	toolCalls: ToolCallRecord[];
	response: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
	inferenceTimeMs: number;
}

export type ProgressEvent =
	| { type: "thinking" }
	| { type: "thinking_delta"; delta: string }
	| { type: "text_delta"; delta: string }
	| { type: "tool_start"; name: string; arguments: Record<string, unknown> }
	| { type: "tool_delta"; name: string; delta: string }
	| { type: "tool_end"; name: string; arguments: Record<string, unknown> }
	| { type: "responding" };

export type OnProgress = (event: ProgressEvent) => void;

export interface AskOptions {
	onProgress?: OnProgress;
}

export interface Session {
	id: string;
	repo: Repo;
	ask(question: string, options?: AskOptions): Promise<AskResult>;
	close(): void;
}

function createSession(repo: Repo): Session {
	const id = randomUUID();
	const model = getModel(config.MODEL_PROVIDER, config.MODEL_NAME);
	const context: Context = {
		systemPrompt: config.SYSTEM_PROMPT,
		messages: [],
		tools,
	};

	let pending: Promise<AskResult> | null = null;
	let closed = false;

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
			if (error.cause) console.error(`Cause: ${JSON.stringify(error.cause, null, 2)}`);
			if (error.stack) console.error(`Stack: ${error.stack}`);
		} else {
			console.error(JSON.stringify(error, null, 2));
		}
		console.error(`${"═".repeat(60)}\n`);
	};

	async function doAsk(question: string, onProgress?: OnProgress): Promise<AskResult> {
		const startTime = Date.now();
		const toolCallRecords: ToolCallRecord[] = [];
		const accumulatedUsage = {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		context.messages.push({ role: "user", content: question, timestamp: Date.now() });

		// Track tool call names during streaming (before we have full arguments)
		const toolCallNames = new Map<number, string>();

		for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
			onProgress?.({ type: "thinking" });

			let response: AssistantMessage;
			try {
				const eventStream = stream(model, context);

				// Process streaming events
				for await (const event of eventStream) {
					switch (event.type) {
						case "thinking_delta":
							onProgress?.({ type: "thinking_delta", delta: event.delta });
							break;
						case "text_delta":
							onProgress?.({ type: "text_delta", delta: event.delta });
							break;
						case "toolcall_start":
							// We don't have the name yet, just track that a tool call started
							break;
						case "toolcall_delta": {
							// Try to parse the name from the partial tool call
							const partialToolCall = event.partial.content[event.contentIndex];
							if (partialToolCall?.type === "toolCall" && partialToolCall.name) {
								const prevName = toolCallNames.get(event.contentIndex);
								if (!prevName) {
									toolCallNames.set(event.contentIndex, partialToolCall.name);
									onProgress?.({ type: "tool_start", name: partialToolCall.name, arguments: {} });
								}
								onProgress?.({ type: "tool_delta", name: partialToolCall.name, delta: event.delta });
							}
							break;
						}
						case "toolcall_end":
							onProgress?.({
								type: "tool_end",
								name: event.toolCall.name,
								arguments: event.toolCall.arguments,
							});
							toolCallNames.delete(event.contentIndex);
							break;
						case "error": {
							const firstTextBlock = event.error?.content?.find((b: { type: string }) => b.type === "text") as
								| { type: "text"; text: string }
								| undefined;
							const errorText =
								event.error?.errorMessage || firstTextBlock?.text || "Unknown API error";
							
							// Create detailed error object for logging
							const errorDetails = {
								message: errorText,
								fullError: event.error,
								iteration: i + 1,
								timestamp: new Date().toISOString(),
							};
							
							logError(`API call failed (iteration ${i + 1})`, errorDetails);
							return {
								prompt: question,
								toolCalls: toolCallRecords,
								response: `[ERROR: API call failed: ${errorText}]`,
								usage: accumulatedUsage,
								inferenceTimeMs: Date.now() - startTime,
							};
						}
					}
				}

				// Get the final response
				response = await eventStream.result();
			} catch (error) {
				// Create detailed error object for logging
				const errorDetails = {
					error: error,
					errorType: error?.constructor?.name,
					iteration: i + 1,
					timestamp: new Date().toISOString(),
					...(error instanceof Error && {
						message: error.message,
						stack: error.stack,
						cause: error.cause,
					}),
				};
				
				logError(`API call failed (iteration ${i + 1})`, errorDetails);
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					prompt: question,
					toolCalls: toolCallRecords,
					response: `[ERROR: API call failed: ${errorMessage}]`,
					usage: accumulatedUsage,
					inferenceTimeMs: Date.now() - startTime,
				};
			}

			// Accumulate usage from this response
			if (response.usage) {
				accumulatedUsage.inputTokens += response.usage.input ?? 0;
				accumulatedUsage.outputTokens += response.usage.output ?? 0;
				accumulatedUsage.totalTokens += response.usage.totalTokens ?? 0;
				accumulatedUsage.cacheReadTokens += response.usage.cacheRead ?? 0;
				accumulatedUsage.cacheWriteTokens += response.usage.cacheWrite ?? 0;
			}

			const apiResponse = response as { stopReason?: string; errorMessage?: string };
			if (apiResponse.stopReason === "error" || apiResponse.errorMessage) {
				const errorMsg = apiResponse.errorMessage || "Unknown API error";
				console.error(`\n${"═".repeat(60)}`);
				console.error("│ API ERROR");
				console.error(`${"═".repeat(60)}`);
				console.error(`Iteration: ${i + 1}`);
				console.error(`Stop Reason: ${apiResponse.stopReason}`);
				console.error(`Error Message: ${errorMsg}`);
				console.error(`Timestamp: ${new Date().toISOString()}`);
				console.error(`Full Response:`, JSON.stringify(apiResponse, null, 2));
				console.error(`${"═".repeat(60)}\n`);
				return {
					prompt: question,
					toolCalls: toolCallRecords,
					response: `[ERROR: ${errorMsg}]`,
					usage: accumulatedUsage,
					inferenceTimeMs: Date.now() - startTime,
				};
			}

			context.messages.push(response);
			const toolCalls = response.content.filter((b) => b.type === "toolCall");

			if (toolCalls.length === 0) {
				onProgress?.({ type: "responding" });
				const textBlocks = response.content.filter((b) => b.type === "text");
				const responseText = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n");

				if (!responseText.trim()) {
					console.error(`\n${"═".repeat(60)}`);
					console.error("│ WARNING: Empty response from API");
					console.error(`${"═".repeat(60)}`);
					console.error("Full response:", JSON.stringify(response, null, 2));
					console.error(`${"═".repeat(60)}\n`);
					return {
						prompt: question,
						toolCalls: toolCallRecords,
						response: "[ERROR: Empty response from API - check API key and credits]",
						usage: accumulatedUsage,
						inferenceTimeMs: Date.now() - startTime,
					};
				}

				log("RESPONSE", "");
				return {
					prompt: question,
					toolCalls: toolCallRecords,
					response: responseText,
					usage: accumulatedUsage,
					inferenceTimeMs: Date.now() - startTime,
				};
			}

			// Execute tool calls in parallel (all tools are I/O bound and read-only)
			const validCalls = toolCalls.filter((call) => call.type === "toolCall");
			for (const call of validCalls) {
				log(`TOOL: ${call.name}`, JSON.stringify(call.arguments, null, 2));
			}
			const toolExecStart = Date.now();
			const results = await Promise.all(
				validCalls.map(async (call) => {
					const t0 = Date.now();
					const result = await executeTool(call.name, call.arguments, repo.localPath);
					log(`TOOL_DONE: ${call.name}`, `${Date.now() - t0}ms`);
					return result;
				}),
			);
			log(`ALL_TOOLS_DONE: ${validCalls.length} calls`, `${Date.now() - toolExecStart}ms`);

			// Push results back in request order to preserve conversation context
			validCalls.forEach((call, j) => {
				toolCallRecords.push({
					name: call.name,
					arguments: call.arguments,
				});
				context.messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: results[j] as string }],
					isError: false,
					timestamp: Date.now(),
				});
			});
		}

		return {
			prompt: question,
			toolCalls: toolCallRecords,
			response: "[ERROR: Max iterations reached without a final answer.]",
			usage: accumulatedUsage,
			inferenceTimeMs: Date.now() - startTime,
		};
	}

	return {
		id,
		repo,

		async ask(question: string, options?: AskOptions): Promise<AskResult> {
			if (closed) {
				throw new Error(`Session ${id} is closed`);
			}

			if (pending) {
				await pending;
			}

			pending = doAsk(question, options?.onProgress);
			const result = await pending;
			pending = null;
			return result;
		},

		close() {
			if (closed) return;
			closed = true;

			// Clean up worktree asynchronously (fire and forget)
			(async () => {
				try {
					// Remove worktree from git's tracking
					const proc = Bun.spawn(["git", "worktree", "remove", "--force", repo.localPath], {
						cwd: repo.cachePath,
						stdout: "pipe",
						stderr: "pipe",
						env: GIT_ENV,
					});
					await proc.exited;
				} catch {
					// Ignore cleanup errors
				}
			})();
		},
	};
}

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
