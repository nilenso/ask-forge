import { randomUUID } from "node:crypto";
import { type AssistantMessage, type Context, getModel, type Message, stream } from "@mariozechner/pi-ai";
import * as config from "./config";
import { executeTool, tools } from "./tools";

export interface Forge {
	name: string;
	buildCloneUrl(repoUrl: string, token?: string): string;
}

export interface Repo {
	url: string;
	localPath: string;
	forge: Forge;
	commitish: string;
	cachePath: string;
}

// GIT_ENV needed for worktree cleanup
const GIT_ENV: Record<string, string> = {
	SSH_AUTH_SOCK: "",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	PATH: process.env.PATH || "",
};

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

export type { Message };

export interface Session {
	id: string;
	repo: Repo;
	ask(question: string, options?: AskOptions): Promise<AskResult>;
	/** Get all messages in the session's conversation context */
	getMessages(): Message[];
	/** Replace all messages in the session's conversation context (useful for restoring session history) */
	replaceMessages(messages: Message[]): void;
	close(): void;
}

export function createSession(repo: Repo): Session {
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
				const eventStream = stream(model, context, {
					// Enable OpenRouter's middle-out transform to automatically compress
					// context when it exceeds the model's limit
					headers: {
						"X-Transform": "middle-out",
					},
				});

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
							const errorText = event.error?.errorMessage || firstTextBlock?.text || "Unknown API error";

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

		getMessages(): Message[] {
			return context.messages;
		},

		replaceMessages(messages: Message[]): void {
			context.messages = messages;
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
