import { describe, expect, mock, test } from "bun:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Repo } from "../src/forge";
import { nullLogger } from "../src/logger";
import type { StreamEvent } from "../src/types";

// Mock the LLM summary call that compaction performs. Without this, triggering
// compaction inside a Session test would hit the real pi-ai stack.
const mockSummaryText = "Mock summary for session-compaction integration test";

mock.module("@mariozechner/pi-ai", () => ({
	// Only completeSimple is invoked at runtime by the compaction path.
	// Session also imports stream/streamSimple/getModel statically, but none
	// are invoked in these tests (config.stream is provided, options.model is not set).
	completeSimple: async () => ({
		role: "assistant",
		content: [{ type: "text", text: mockSummaryText }],
		stopReason: "end_turn",
		api: "messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	}),
}));

import { Session, type SessionConfig } from "../src/session";

function createMockRepo(): Repo {
	return {
		url: "https://github.com/test/repo",
		localPath: "/tmp/test-repo",
		cachePath: "/tmp/cache",
		commitish: "abc123",
		forge: {
			name: "github",
			buildCloneUrl: (url: string) => url,
		},
	};
}

function createMockStream(): SessionConfig["stream"] {
	return (() => ({
		[Symbol.asyncIterator]: async function* () {
			yield { type: "text_delta", delta: "Hello" };
		},
		result: async () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Hello" }],
			usage: { input: 10, output: 5, totalTokens: 15 },
			timestamp: Date.now(),
			api: "test",
			provider: "test",
			model: "test",
			stopReason: "end_turn",
		}),
	})) as unknown as SessionConfig["stream"];
}

function createMockConfig(overrides?: Partial<SessionConfig>): SessionConfig {
	return {
		model: {} as Model<Api>,
		systemPrompt: "You are a test assistant",
		tools: [],
		maxIterations: 5,
		executeTool: async () => "mock",
		logger: nullLogger,
		stream: createMockStream(),
		...overrides,
	};
}

describe("Session compaction integration (issue #120)", () => {
	// Regression for issue #120. This test observes the end-to-end thread:
	// SessionConfig.compaction -> Session.#runCompaction -> maybeCompact.
	//
	// Mechanism: defaults use contextWindow=200000, so a small prompt skips
	// compaction. A caller-provided contextWindow=0 forces compaction for any
	// non-empty conversation. If Session drops config.compaction on the floor
	// (pre-fix behavior), the test sees no `compaction` event.
	test("config.compaction.contextWindow flows through to trigger compaction", async () => {
		const session = new Session(
			createMockRepo(),
			createMockConfig({
				compaction: { contextWindow: 0, reserveTokens: 0, keepRecentTokens: 1 },
			}),
		);

		const events: StreamEvent[] = [];
		for await (const ev of session.ask("anything")) {
			events.push(ev);
		}

		const compactionEvent = events.find((e) => e.type === "compaction");
		expect(compactionEvent).toBeDefined();
	});
});
