import type { Api, AssistantMessage, Context, stream as defaultStream, Model } from "@mariozechner/pi-ai";
import type { OnProgress, ProgressEvent } from "./session";

// =============================================================================
// Types
// =============================================================================

export interface StreamSuccess {
	ok: true;
	response: AssistantMessage;
}

export interface StreamError {
	ok: false;
	error: string;
	errorDetails?: unknown;
}

export type StreamOutcome = StreamSuccess | StreamError;

// =============================================================================
// Helper Functions
// =============================================================================

function extractErrorText(error: unknown): string {
	const err = error as { errorMessage?: string; content?: { type: string; text?: string }[] } | undefined;
	const firstTextBlock = err?.content?.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
	return err?.errorMessage || firstTextBlock?.text || "Unknown API error";
}

/**
 * Maps a raw stream event to a ProgressEvent.
 * Returns the progress event to emit, or an error if the stream errored.
 * Handles toolCallNames state for deduplicating tool_start events.
 */
function mapStreamEvent(
	event: { type: string; [key: string]: unknown },
	toolCallNames: Map<number, string>,
): { progress?: ProgressEvent; error?: { text: string; details: unknown } } {
	switch (event.type) {
		case "thinking_delta":
			return { progress: { type: "thinking_delta", delta: event.delta as string } };

		case "text_delta":
			return { progress: { type: "text_delta", delta: event.delta as string } };

		case "toolcall_start":
			// We don't have the name yet, no event to emit
			return {};

		case "toolcall_delta": {
			const partial = event.partial as { content: { type: string; name?: string }[] };
			const contentIndex = event.contentIndex as number;
			const partialToolCall = partial.content[contentIndex];

			if (partialToolCall?.type === "toolCall" && partialToolCall.name) {
				// Check if we need to emit tool_start first
				if (!toolCallNames.has(contentIndex)) {
					toolCallNames.set(contentIndex, partialToolCall.name);
					// Return tool_start - caller should also emit tool_delta after
					// But we can only return one event, so we need a different approach
				}
				return { progress: { type: "tool_delta", name: partialToolCall.name, delta: event.delta as string } };
			}
			return {};
		}

		case "toolcall_end": {
			const toolCall = event.toolCall as { name: string; arguments: Record<string, unknown> };
			const contentIndex = event.contentIndex as number;
			toolCallNames.delete(contentIndex);
			return { progress: { type: "tool_end", name: toolCall.name, arguments: toolCall.arguments } };
		}

		case "error": {
			const errorText = extractErrorText(event.error);
			return { error: { text: errorText, details: event.error } };
		}

		default:
			return {};
	}
}

/**
 * Processes a stream event, emitting progress events and handling errors.
 * Returns an error result if the stream errored, otherwise null.
 */
function handleStreamEvent(
	event: { type: string; [key: string]: unknown },
	toolCallNames: Map<number, string>,
	onProgress?: OnProgress,
): { text: string; details: unknown } | null {
	// Special handling for toolcall_delta to emit tool_start first if needed
	if (event.type === "toolcall_delta") {
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
		return null;
	}

	const result = mapStreamEvent(event, toolCallNames);

	if (result.error) {
		return result.error;
	}

	if (result.progress) {
		onProgress?.(result.progress);
	}

	return null;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Processes a stream from the AI model, emitting progress events and returning the outcome.
 *
 * @param streamFn - The stream function to use (injectable for testing)
 * @param model - The model to use
 * @param context - The conversation context
 * @param onProgress - Optional callback for progress events (called in real-time)
 * @returns StreamOutcome - either success with response, or error with details
 */
export async function processStream(
	streamFn: typeof defaultStream,
	model: Model<Api>,
	context: Context,
	onProgress?: OnProgress,
): Promise<StreamOutcome> {
	const toolCallNames = new Map<number, string>();

	try {
		const eventStream = streamFn(model, context);

		for await (const event of eventStream) {
			const error = handleStreamEvent(event, toolCallNames, onProgress);
			if (error) {
				return {
					ok: false,
					error: `API call failed: ${error.text}`,
					errorDetails: error.details,
				};
			}
		}

		return {
			ok: true,
			response: await eventStream.result(),
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `API call failed: ${errorMessage}`,
			errorDetails: error,
		};
	}
}
