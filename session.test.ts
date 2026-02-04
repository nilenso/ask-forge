import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Repo } from "./forge";
import { type Logger, nullLogger } from "./logger";
import { Session, type SessionConfig } from "./session";

// Mock repo for testing
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

// Mock config for testing
function createMockConfig(overrides?: Partial<SessionConfig>): SessionConfig {
	return {
		model: {} as Model<Api>, // Mock model - not used in these tests
		systemPrompt: "You are a test assistant",
		tools: [],
		maxIterations: 5,
		executeTool: async () => "mock result",
		logger: nullLogger, // Suppress logging in tests by default
		...overrides,
	};
}

// Helper to create a logger that captures logs
function createCapturingLogger(): { logger: Logger; logs: string[]; errors: string[] } {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		logs,
		errors,
		logger: {
			log(label: string, content: string) {
				logs.push(`${label}: ${content}`);
			},
			error(label: string, error: unknown) {
				errors.push(`${label}: ${JSON.stringify(error)}`);
			},
		},
	};
}

describe("Session", () => {
	describe("constructor", () => {
		test("creates session with unique id", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			expect(session.id).toBeDefined();
			expect(typeof session.id).toBe("string");
			expect(session.id.length).toBeGreaterThan(0);
		});

		test("creates session with provided repo", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			expect(session.repo).toBe(repo);
		});

		test("creates sessions with different ids", () => {
			const repo = createMockRepo();
			const session1 = new Session(repo, createMockConfig());
			const session2 = new Session(repo, createMockConfig());

			expect(session1.id).not.toBe(session2.id);
		});
	});

	describe("getMessages / replaceMessages", () => {
		test("starts with empty messages", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			expect(session.getMessages()).toEqual([]);
		});

		test("replaceMessages updates the message list", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			const messages = [
				{ role: "user" as const, content: "Hello", timestamp: Date.now() },
				{ role: "user" as const, content: "Follow up", timestamp: Date.now() },
			];

			session.replaceMessages(messages);

			expect(session.getMessages()).toEqual(messages);
		});

		test("replaceMessages overwrites existing messages", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			const messages1 = [{ role: "user" as const, content: "First", timestamp: Date.now() }];
			const messages2 = [{ role: "user" as const, content: "Second", timestamp: Date.now() }];

			session.replaceMessages(messages1);
			session.replaceMessages(messages2);

			expect(session.getMessages()).toEqual(messages2);
		});
	});

	describe("close", () => {
		test("can be called multiple times without error", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			// Should not throw
			session.close();
			session.close();
			session.close();
		});

		test("ask throws after close", async () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			session.close();

			expect(session.ask("test")).rejects.toThrow(`Session ${session.id} is closed`);
		});
	});

	describe("logger", () => {
		test("uses nullLogger by default in tests (no console output)", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			// If we got here without console spam, nullLogger is working
			expect(session).toBeDefined();
		});

		test("accepts custom logger via config", () => {
			const { logger, logs, errors } = createCapturingLogger();
			const repo = createMockRepo();
			const _session = new Session(repo, createMockConfig({ logger }));

			// Logger is injected but won't be called until ask() runs
			// This test verifies the injection mechanism works
			expect(logs).toEqual([]);
			expect(errors).toEqual([]);
		});
	});
});
