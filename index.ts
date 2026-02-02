import { randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type AssistantMessage,
	type Context,
	getModel,
	type Message,
	stream,
	type Tool,
	type ToolCall,
	type Usage,
} from "@mariozechner/pi-ai";

export type { Message, ToolCall, Usage } from "@mariozechner/pi-ai";

import { Type } from "@sinclair/typebox";
import * as config from "./config";
import { SandboxClient } from "./sandbox/client";
import { executeSandboxedTool } from "./sandbox/srt-executor";

// Re-export for consumers
export { SandboxClient } from "./sandbox/client";

// =============================================================================
// TOOL EXECUTOR ABSTRACTION
// =============================================================================

/**
 * A ToolExecutor knows how to run tools (rg, fd, ls, read) against a repo.
 * Three implementations:
 *   - local: runs tools directly on host (no isolation)
 *   - container: delegates to sandbox service via HTTP (Docker/gVisor isolation)
 *   - srt: uses Anthropic Sandbox Runtime for OS-level process sandboxing
 */
interface ToolExecutor {
	executeTool(name: string, args: Record<string, unknown>): Promise<string>;
	close(): Promise<void>;
}

// =============================================================================
// CONTAINER TOOL EXECUTOR
// =============================================================================

class ContainerToolExecutor implements ToolExecutor {
	constructor(
		private client: SandboxClient,
		private slug: string,
		private sha: string,
	) {}

	async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
		return this.client.executeTool(this.slug, this.sha, name, args);
	}

	async close(): Promise<void> {
		// Nothing to clean up — repos live on tmpfs inside the container.
		// They vanish when the container restarts.
	}
}

// =============================================================================
// SRT TOOL EXECUTOR (Anthropic Sandbox Runtime — OS-level sandboxing)
// =============================================================================

class SrtToolExecutor implements ToolExecutor {
	constructor(private repoPath: string) {}

	async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
		return executeSandboxedTool(name, args, this.repoPath);
	}

	async close(): Promise<void> {
		// SandboxManager is process-global; don't reset per-session.
		// Call resetSandbox() on process exit if needed.
	}
}

// =============================================================================
// LOCAL TOOL EXECUTOR (fallback when no SANDBOX_URL or SANDBOX_MODE)
// =============================================================================

// Git environment to prevent interactive prompts and SSH key loading
const GIT_ENV: Record<string, string> = {
	SSH_AUTH_SOCK: "",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	PATH: process.env.PATH || "",
};

class LocalToolExecutor implements ToolExecutor {
	constructor(
		private repoPath: string,
		private cachePath: string,
	) {}

	async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
		return executeLocalTool(name, args, this.repoPath);
	}

	async close(): Promise<void> {
		try {
			const proc = Bun.spawn(["git", "worktree", "remove", "--force", this.repoPath], {
				cwd: this.cachePath,
				stdout: "pipe",
				stderr: "pipe",
				env: GIT_ENV,
			});
			await proc.exited;
		} catch {
			// Ignore cleanup errors
		}
	}
}

async function runLocalCommand(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		return `Error (exit ${exitCode}):\n${stderr}`;
	}
	return stdout || "(no output)";
}

async function executeLocalTool(toolName: string, args: Record<string, unknown>, repoPath: string): Promise<string> {
	if (toolName === "rg") {
		const pattern = args.pattern as string;
		const glob = args.glob as string | undefined;
		const cmd = ["rg", "--line-number", pattern];
		if (glob) cmd.push("--glob", glob);
		return runLocalCommand(cmd, repoPath);
	}

	if (toolName === "fd") {
		const pattern = args.pattern as string;
		const type = args.type as "f" | "d" | undefined;
		const cmd = ["find", ".", "-name", `*${pattern}*`];
		if (type === "f") cmd.push("-type", "f");
		else if (type === "d") cmd.push("-type", "d");
		return runLocalCommand(cmd, repoPath);
	}

	if (toolName === "ls") {
		const path = (args.path as string | undefined) || ".";
		return runLocalCommand(["ls", "-la", path], repoPath);
	}

	if (toolName === "read") {
		const filePath = args.path as string;
		const fullPath = resolve(repoPath, filePath);
		// Prevent path traversal outside the repo directory
		if (!fullPath.startsWith(resolve(repoPath))) {
			return `Error reading file: path traversal not allowed: ${filePath}`;
		}
		try {
			return await readFile(fullPath, "utf-8");
		} catch (e) {
			return `Error reading file: ${(e as Error).message}`;
		}
	}

	return `Unknown tool: ${toolName}`;
}

// =============================================================================
// LOCAL REPO CLONING (fallback)
// =============================================================================

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

// =============================================================================
// FORGE TYPES
// =============================================================================

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

// =============================================================================
// PUBLIC TYPES
// =============================================================================

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
	replaceMessages(messages: Message[]): void;
	getMessages(): Message[];
	close(): Promise<void>;
}

// =============================================================================
// TOOLS (shared between both executors — these define the LLM's tool schema)
// =============================================================================

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

// =============================================================================
// SESSION
// =============================================================================

function createSession(repo: Repo, executor: ToolExecutor): Session {
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
		const toolCallRecords: ToolCall[] = [];
		const accumulatedUsage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		context.messages.push({ role: "user", content: question, timestamp: Date.now() });

		const toolCallNames = new Map<number, string>();

		for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
			onProgress?.({ type: "thinking" });

			let response: AssistantMessage;
			try {
				const eventStream = stream(model, context);

				for await (const event of eventStream) {
					switch (event.type) {
						case "thinking_delta":
							onProgress?.({ type: "thinking_delta", delta: event.delta });
							break;
						case "text_delta":
							onProgress?.({ type: "text_delta", delta: event.delta });
							break;
						case "toolcall_start":
							break;
						case "toolcall_delta": {
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
							const errorText = event.error?.errorMessage || firstTextBlock?.text || "Unknown API error";

							logError(`API call failed (iteration ${i + 1})`, {
								message: errorText,
								fullError: event.error,
								iteration: i + 1,
								timestamp: new Date().toISOString(),
							});
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

				response = await eventStream.result();
			} catch (error) {
				logError(`API call failed (iteration ${i + 1})`, {
					error,
					errorType: error?.constructor?.name,
					iteration: i + 1,
					timestamp: new Date().toISOString(),
					...(error instanceof Error && {
						message: error.message,
						stack: error.stack,
						cause: error.cause,
					}),
				});
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					prompt: question,
					toolCalls: toolCallRecords,
					response: `[ERROR: API call failed: ${errorMessage}]`,
					usage: accumulatedUsage,
					inferenceTimeMs: Date.now() - startTime,
				};
			}

			if (response.usage) {
				accumulatedUsage.input += response.usage.input ?? 0;
				accumulatedUsage.output += response.usage.output ?? 0;
				accumulatedUsage.totalTokens += response.usage.totalTokens ?? 0;
				accumulatedUsage.cacheRead += response.usage.cacheRead ?? 0;
				accumulatedUsage.cacheWrite += response.usage.cacheWrite ?? 0;
				if (response.usage.cost) {
					accumulatedUsage.cost.input += response.usage.cost.input ?? 0;
					accumulatedUsage.cost.output += response.usage.cost.output ?? 0;
					accumulatedUsage.cost.cacheRead += response.usage.cost.cacheRead ?? 0;
					accumulatedUsage.cost.cacheWrite += response.usage.cost.cacheWrite ?? 0;
					accumulatedUsage.cost.total += response.usage.cost.total ?? 0;
				}
			}

			const apiResponse = response as { stopReason?: string; errorMessage?: string };
			if (apiResponse.stopReason === "error" || apiResponse.errorMessage) {
				const errorMsg = apiResponse.errorMessage || "Unknown API error";
				logError("API ERROR", {
					iteration: i + 1,
					stopReason: apiResponse.stopReason,
					errorMessage: errorMsg,
				});
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
					logError("Empty response from API", { response });
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

			// Execute tool calls in parallel
			const validCalls = toolCalls.filter((call) => call.type === "toolCall");
			for (const call of validCalls) {
				log(`TOOL: ${call.name}`, JSON.stringify(call.arguments, null, 2));
			}
			const toolExecStart = Date.now();
			const results = await Promise.all(
				validCalls.map(async (call) => {
					const t0 = Date.now();
					const result = await executor.executeTool(call.name, call.arguments);
					log(`TOOL_DONE: ${call.name}`, `${Date.now() - t0}ms`);
					return result;
				}),
			);
			log(`ALL_TOOLS_DONE: ${validCalls.length} calls`, `${Date.now() - toolExecStart}ms`);

			validCalls.forEach((call, j) => {
				toolCallRecords.push(call);
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

		replaceMessages(messages: Message[]) {
			context.messages = messages;
		},

		getMessages(): Message[] {
			return context.messages;
		},

		async close() {
			if (closed) return;
			closed = true;
			await executor.close();
		},
	};
}

// =============================================================================
// LOCAL CONNECT (fallback — clones on the host)
// =============================================================================

async function connectLocal(repoUrl: string, options: ConnectOptions = {}): Promise<Session> {
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
		const headFile = join(cachePath, "HEAD");
		if (await exists(headFile)) {
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

	if (!(await exists(worktreePath))) {
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
	}

	const repo: Repo = {
		url: repoUrl,
		localPath: worktreePath,
		forge,
		commitish: sha,
		cachePath: resolve(cachePath),
	};

	const executor = isSrtMode()
		? new SrtToolExecutor(worktreePath)
		: new LocalToolExecutor(worktreePath, resolve(cachePath));
	return createSession(repo, executor);
}

// =============================================================================
// CONTAINER CONNECT (delegates to sandbox service)
// =============================================================================

/** Shared SandboxClient — one per process, reused across sessions. */
let sharedSandboxClient: SandboxClient | null = null;

async function connectContainer(repoUrl: string, options: ConnectOptions = {}): Promise<Session> {
	const forgeName = options.forge ?? inferForge(repoUrl);
	if (!forgeName) {
		throw new Error(`Cannot infer forge from URL: ${repoUrl}. Please specify 'forge' option.`);
	}

	const forge = forges[forgeName];
	const commitish = options.commitish ?? "HEAD";

	// Build the clone URL (with token embedded if provided)
	const cloneUrl = forge.buildCloneUrl(repoUrl, options.token);

	if (!sharedSandboxClient) {
		sharedSandboxClient = new SandboxClient();
		console.log(`[sandbox] Connecting to sandbox service at ${process.env.SANDBOX_URL || "http://sandbox:8080"}`);
		await sharedSandboxClient.waitForReady();
		console.log("[sandbox] Sandbox service is ready");
	}

	const { slug, sha } = await sharedSandboxClient.clone(cloneUrl, commitish);

	const repo: Repo = {
		url: repoUrl,
		localPath: `sandbox://${slug}/trees/${sha.slice(0, 12)}`,
		forge,
		commitish: sha,
		cachePath: `sandbox://${slug}/bare`,
	};

	const executor = new ContainerToolExecutor(sharedSandboxClient, slug, sha);
	return createSession(repo, executor);
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Returns true if the container sandbox service is configured (SANDBOX_URL is set).
 */
export function isSandboxMode(): boolean {
	return !!process.env.SANDBOX_URL;
}

/**
 * Returns true if Anthropic Sandbox Runtime (srt) mode is enabled.
 * Set SANDBOX_MODE=srt to use OS-level process sandboxing via bubblewrap/sandbox-exec.
 */
export function isSrtMode(): boolean {
	return process.env.SANDBOX_MODE === "srt";
}

/**
 * Connect to a repository and create a session.
 *
 * Execution mode is selected by environment variables:
 *   - SANDBOX_URL set → container mode (Docker/gVisor isolation)
 *   - SANDBOX_MODE=srt → Anthropic Sandbox Runtime (OS-level bubblewrap/sandbox-exec)
 *   - Neither → local mode (no isolation, tools run directly on host)
 *
 * @param repoUrl - The URL of the repository to connect to
 * @param options - Connection options (token, forge override, commitish)
 * @returns A Session for asking questions about the repository
 */
export async function connect(repoUrl: string, options: ConnectOptions = {}): Promise<Session> {
	if (isSandboxMode()) {
		return connectContainer(repoUrl, options);
	}
	return connectLocal(repoUrl, options);
}
