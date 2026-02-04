import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	stream,
	type Tool,
} from "@mariozechner/pi-ai";
import { cleanupWorktree, type Repo } from "./forge";
import { consoleLogger, type Logger } from "./logger";

// =============================================================================
// Types
// =============================================================================

export interface ToolCallRecord {
	name: string;
	arguments: Record<string, unknown>;
}

export interface AskResult {
	prompt: string;
	toolCalls: ToolCallRecord[];
	response: string;
	usage: Usage;
	inferenceTimeMs: number;
}

interface Usage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
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

// =============================================================================
// Helper Functions
// =============================================================================

function extractErrorText(error: unknown): string {
	const err = error as { errorMessage?: string; content?: { type: string; text?: string }[] } | undefined;
	const firstTextBlock = err?.content?.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
	return err?.errorMessage || firstTextBlock?.text || "Unknown API error";
}

function createEmptyUsage(): Usage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
}

function accumulateUsage(accumulated: Usage, response: AssistantMessage): void {
	if (response.usage) {
		accumulated.inputTokens += response.usage.input ?? 0;
		accumulated.outputTokens += response.usage.output ?? 0;
		accumulated.totalTokens += response.usage.totalTokens ?? 0;
		accumulated.cacheReadTokens += response.usage.cacheRead ?? 0;
		accumulated.cacheWriteTokens += response.usage.cacheWrite ?? 0;
	}
}

/** Context for building results throughout an ask operation */
interface AskContext {
	question: string;
	toolCalls: ToolCallRecord[];
	usage: Usage;
	startTime: number;
}

function buildResult(ctx: AskContext, response: string): AskResult {
	return {
		prompt: ctx.question,
		toolCalls: ctx.toolCalls,
		response,
		usage: ctx.usage,
		inferenceTimeMs: Date.now() - ctx.startTime,
	};
}

// =============================================================================
// Session Class
// =============================================================================

export interface SessionConfig {
	model: Model<Api>;
	systemPrompt: string;
	tools: Tool[];
	maxIterations: number;
	executeTool: (name: string, args: Record<string, unknown>, cwd: string) => Promise<string>;
	logger?: Logger;
}

export class Session {
	readonly id: string;
	readonly repo: Repo;

	#config: SessionConfig;
	#logger: Logger;
	#context: Context;
	#pending: Promise<AskResult> | null = null;
	#closed = false;

	constructor(repo: Repo, config: SessionConfig) {
		this.id = randomUUID();
		this.repo = repo;
		this.#config = config;
		this.#logger = config.logger ?? consoleLogger;
		this.#context = {
			systemPrompt: config.systemPrompt,
			messages: [],
			tools: config.tools,
		};
	}

	async ask(question: string, options?: AskOptions): Promise<AskResult> {
		if (this.#closed) {
			throw new Error(`Session ${this.id} is closed`);
		}

		// Serialize concurrent calls
		if (this.#pending) {
			await this.#pending;
		}

		this.#pending = this.#doAsk(question, options?.onProgress);
		const result = await this.#pending;
		this.#pending = null;
		return result;
	}

	getMessages(): Message[] {
		return this.#context.messages;
	}

	replaceMessages(messages: Message[]): void {
		this.#context.messages = messages;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;

		// Clean up worktree asynchronously (fire and forget)
		cleanupWorktree(this.repo);
	}

	async #doAsk(question: string, onProgress?: OnProgress): Promise<AskResult> {
		const ctx: AskContext = {
			question,
			toolCalls: [],
			usage: createEmptyUsage(),
			startTime: Date.now(),
		};

		this.#context.messages.push({ role: "user", content: question, timestamp: Date.now() });

		for (let iteration = 0; iteration < this.#config.maxIterations; iteration++) {
			onProgress?.({ type: "thinking" });

			const iterationResult = await this.#processIteration(ctx, iteration, onProgress);

			if (iterationResult.done) {
				return iterationResult.result;
			}
		}

		return buildResult(ctx, "[ERROR: Max iterations reached without a final answer.]");
	}

	async #processIteration(
		ctx: AskContext,
		iteration: number,
		onProgress?: OnProgress,
	): Promise<{ done: true; result: AskResult } | { done: false }> {
		// Track tool call names during streaming (before we have full arguments)
		const toolCallNames = new Map<number, string>();

		let response: AssistantMessage;
		try {
			const eventStream = stream(this.#config.model, this.#context, {
				headers: { "X-Transform": "middle-out" },
			});

			// Process streaming events
			for await (const event of eventStream) {
				const errorResult = this.#handleStreamEvent(event, toolCallNames, ctx, iteration, onProgress);
				if (errorResult) {
					return { done: true, result: errorResult };
				}
			}

			response = await eventStream.result();
		} catch (error) {
			this.#logger.error(`API call failed (iteration ${iteration + 1})`, {
				error,
				errorType: error?.constructor?.name,
				iteration: iteration + 1,
				timestamp: new Date().toISOString(),
				...(error instanceof Error && {
					message: error.message,
					stack: error.stack,
					cause: error.cause,
				}),
			});
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				done: true,
				result: buildResult(ctx, `[ERROR: API call failed: ${errorMessage}]`),
			};
		}

		accumulateUsage(ctx.usage, response);

		// Check for API error in response
		const apiResponse = response as { stopReason?: string; errorMessage?: string };
		if (apiResponse.stopReason === "error" || apiResponse.errorMessage) {
			const errorMsg = apiResponse.errorMessage || "Unknown API error";
			this.#logger.error("API ERROR", {
				iteration: iteration + 1,
				stopReason: apiResponse.stopReason,
				errorMessage: errorMsg,
				timestamp: new Date().toISOString(),
				fullResponse: apiResponse,
			});
			return {
				done: true,
				result: buildResult(ctx, `[ERROR: ${errorMsg}]`),
			};
		}

		this.#context.messages.push(response);

		// Check if we have a final text response (no tool calls)
		const responseToolCalls = response.content.filter((b) => b.type === "toolCall");
		if (responseToolCalls.length === 0) {
			return {
				done: true,
				result: this.#buildTextResponse(ctx, response, onProgress),
			};
		}

		// Execute tool calls
		await this.#executeToolCalls(responseToolCalls, ctx.toolCalls);

		return { done: false };
	}

	#handleStreamEvent(
		event: { type: string; [key: string]: unknown },
		toolCallNames: Map<number, string>,
		ctx: AskContext,
		iteration: number,
		onProgress?: OnProgress,
	): AskResult | null {
		switch (event.type) {
			case "thinking_delta":
				onProgress?.({ type: "thinking_delta", delta: event.delta as string });
				break;
			case "text_delta":
				onProgress?.({ type: "text_delta", delta: event.delta as string });
				break;
			case "toolcall_start":
				// We don't have the name yet
				break;
			case "toolcall_delta": {
				const partial = event.partial as { content: { type: string; name?: string }[] };
				const contentIndex = event.contentIndex as number;
				const partialToolCall = partial.content[contentIndex];
				if (partialToolCall?.type === "toolCall" && partialToolCall.name) {
					if (!toolCallNames.has(contentIndex)) {
						toolCallNames.set(contentIndex, partialToolCall.name);
						onProgress?.({ type: "tool_start", name: partialToolCall.name, arguments: {} });
					}
					onProgress?.({ type: "tool_delta", name: partialToolCall.name, delta: event.delta as string });
				}
				break;
			}
			case "toolcall_end": {
				const toolCall = event.toolCall as { name: string; arguments: Record<string, unknown> };
				const contentIndex = event.contentIndex as number;
				onProgress?.({ type: "tool_end", name: toolCall.name, arguments: toolCall.arguments });
				toolCallNames.delete(contentIndex);
				break;
			}
			case "error": {
				const errorText = extractErrorText(event.error);
				this.#logger.error(`API call failed (iteration ${iteration + 1})`, {
					message: errorText,
					fullError: event.error,
					iteration: iteration + 1,
					timestamp: new Date().toISOString(),
				});
				return buildResult(ctx, `[ERROR: API call failed: ${errorText}]`);
			}
		}
		return null;
	}

	#buildTextResponse(ctx: AskContext, response: AssistantMessage, onProgress?: OnProgress): AskResult {
		onProgress?.({ type: "responding" });

		const textBlocks = response.content.filter((b) => b.type === "text");
		const responseText = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n");

		if (!responseText.trim()) {
			this.#logger.error("WARNING: Empty response from API", { fullResponse: response });
			return buildResult(ctx, "[ERROR: Empty response from API - check API key and credits]");
		}

		this.#logger.log("RESPONSE", "");
		return buildResult(ctx, responseText);
	}

	async #executeToolCalls(
		toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
		toolCallRecords: ToolCallRecord[],
	): Promise<void> {
		for (const call of toolCalls) {
			this.#logger.log(`TOOL: ${call.name}`, JSON.stringify(call.arguments, null, 2));
		}

		const toolExecStart = Date.now();
		const results = await Promise.all(
			toolCalls.map(async (call) => {
				const t0 = Date.now();
				const result = await this.#config.executeTool(call.name, call.arguments, this.repo.localPath);
				this.#logger.log(`TOOL_DONE: ${call.name}`, `${Date.now() - t0}ms`);
				return result;
			}),
		);
		this.#logger.log(`ALL_TOOLS_DONE: ${toolCalls.length} calls`, `${Date.now() - toolExecStart}ms`);

		// Push results back in request order to preserve conversation context
		toolCalls.forEach((call, j) => {
			toolCallRecords.push({
				name: call.name,
				arguments: call.arguments,
			});
			this.#context.messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: results[j] as string }],
				isError: false,
				timestamp: Date.now(),
			});
		});
	}
}
