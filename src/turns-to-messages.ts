/**
 * Converts TurnResult[] back into pi-ai Message[] for session context restoration.
 *
 * When a Session is lost (e.g. server restart), consumers can restore context
 * by passing prior TurnResults to SessionConfig.initialTurns. This module
 * handles the TurnResult → Message[] conversion.
 *
 * Thinking steps are intentionally excluded because pi-ai's ThinkingContent
 * requires a thinkingSignature for multi-turn continuity (Anthropic), which
 * TurnResult steps don't preserve.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { TurnResult } from "./types";

/** Result of reconstructing context from prior turns. */
export interface ReconstructedContext {
	/** Flat array of pi-ai Messages representing the full conversation history. */
	messages: Message[];
	/** Message snapshot after each turn, keyed by turn ID. Used for afterTurn branching. */
	turnSnapshots: Map<string, Message[]>;
}

/** Zeroed-out usage for reconstructed AssistantMessages. */
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/**
 * Reconstruct pi-ai Messages and turn snapshots from prior TurnResults.
 *
 * For each turn, produces:
 * 1. A UserMessage from the turn's prompt
 * 2. AssistantMessage / ToolResultMessage sequences from the turn's steps
 *
 * Turn snapshots are built incrementally — each turn's snapshot contains
 * all messages up to and including that turn.
 */
export function reconstructContext(turns: readonly TurnResult[]): ReconstructedContext {
	const messages: Message[] = [];
	const turnSnapshots = new Map<string, Message[]>();

	for (const turn of turns) {
		appendTurnMessages(messages, turn);
		turnSnapshots.set(turn.id, [...messages]);
	}

	return { messages, turnSnapshots };
}

/**
 * Append Messages for a single TurnResult to the messages array (mutates in place).
 *
 * Message structure per turn:
 *   UserMessage(prompt)
 *   [AssistantMessage(text + toolCalls)]  ← per iteration
 *   [ToolResultMessage × N]
 *   ...
 *   AssistantMessage(final text)          ← last iteration (no tool calls)
 */
function appendTurnMessages(messages: Message[], turn: TurnResult): void {
	// 1. User message
	messages.push({
		role: "user",
		content: turn.prompt,
		timestamp: turn.startedAt,
	});

	// 2. Walk steps, grouping into AssistantMessage + ToolResultMessage sequences
	const provider = turn.metadata.model.provider;
	const model = turn.metadata.model.id;

	type ContentBlock =
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

	let contentBlocks: ContentBlock[] = [];
	let pendingToolResults: Message[] = [];

	/** Flush current AssistantMessage + pending ToolResults into messages. */
	const flush = () => {
		if (contentBlocks.length > 0) {
			const hasToolCalls = contentBlocks.some((b) => b.type === "toolCall");
			messages.push({
				role: "assistant",
				content: contentBlocks,
				api: "reconstructed",
				provider,
				model,
				usage: ZERO_USAGE,
				stopReason: hasToolCalls ? "toolUse" : "stop",
				timestamp: turn.startedAt,
			} as Message);
			contentBlocks = [];
		}
		for (const tr of pendingToolResults) {
			messages.push(tr);
		}
		pendingToolResults = [];
	};

	for (const step of turn.steps) {
		switch (step.type) {
			case "text": {
				// A text step after tool results means a new iteration has started.
				// Flush the previous iteration's AssistantMessage + ToolResults first.
				if (pendingToolResults.length > 0) {
					flush();
				}
				contentBlocks.push({ type: "text", text: step.text });
				break;
			}

			case "tool_call": {
				contentBlocks.push({
					type: "toolCall",
					id: step.id,
					name: step.name,
					arguments: step.params,
				});
				pendingToolResults.push({
					role: "toolResult",
					toolCallId: step.id,
					toolName: step.name,
					content: [{ type: "text", text: step.output }],
					isError: step.isError,
					timestamp: turn.startedAt,
				});
				break;
			}

			// Skip thinking, compaction, error, iteration_start — not needed for context
			default:
				break;
		}
	}

	// Flush any remaining content from the last iteration
	flush();
}
