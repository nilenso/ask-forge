/**
 * Unit tests for sandbox worker tool execution consistency.
 *
 * These tests verify that the worker uses shared tool definitions from tools.ts
 * rather than duplicating tool logic. They don't require a running sandbox.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALLOWED_GIT_COMMANDS, tools } from "../../src/tools";

const WORKER_SOURCE = readFileSync(resolve(__dirname, "../../src/sandbox/worker.ts"), "utf-8");

// ---------------------------------------------------------------------------
// Tool name parity
// ---------------------------------------------------------------------------
describe("worker tool name parity", () => {
	test("worker handles all tool names defined in tools[]", () => {
		const toolNames = tools.map((t) => t.name);

		// Worker should delegate non-git tools to executeTool (which handles them all)
		// and handle "git" as a special case
		for (const name of toolNames) {
			if (name === "git") {
				// git is handled as a special case with isolatedGitToolCommand
				expect(WORKER_SOURCE).toContain('name === "git"');
			}
			// All other tools go through executeTool — verified by the import
		}

		// Worker must import executeTool from tools.ts
		expect(WORKER_SOURCE).toContain("executeTool");
		expect(WORKER_SOURCE).toContain('from "../tools"');
	});

	test("worker does NOT have duplicated tool switch cases", () => {
		// The old worker had individual case blocks for rg, find, ls, read
		// These should all be gone now
		expect(WORKER_SOURCE).not.toContain('case "rg":');
		expect(WORKER_SOURCE).not.toContain('case "find":');
		expect(WORKER_SOURCE).not.toContain('case "ls":');
		expect(WORKER_SOURCE).not.toContain('case "read":');
		expect(WORKER_SOURCE).not.toContain('case "git":');
	});
});

// ---------------------------------------------------------------------------
// Sandbox runner
// ---------------------------------------------------------------------------
describe("sandbox runner", () => {
	test("worker defines makeSandboxRunner that wraps with runToolIsolated", () => {
		// makeSandboxRunner should exist and call runToolIsolated
		expect(WORKER_SOURCE).toContain("makeSandboxRunner");
		expect(WORKER_SOURCE).toContain("runToolIsolated");
	});

	test("non-git tools use executeTool with sandbox runner", () => {
		// handleTool should call executeTool with the sandbox runner for non-git tools
		expect(WORKER_SOURCE).toContain("executeTool(name, args, worktree, sandboxRunner)");
	});
});

// ---------------------------------------------------------------------------
// Git special case
// ---------------------------------------------------------------------------
describe("git tool in worker", () => {
	test("git uses isolatedGitToolCommand (not standard sandbox runner)", () => {
		// Git needs different bwrap topology (bare repo mount)
		expect(WORKER_SOURCE).toContain("isolatedGitToolCommand");
	});

	test("git uses shared ALLOWED_GIT_COMMANDS from tools.ts", () => {
		// Worker should import and use ALLOWED_GIT_COMMANDS, not hardcode its own list
		expect(WORKER_SOURCE).toContain("ALLOWED_GIT_COMMANDS");
		// Should NOT have a local allowedCommands array
		expect(WORKER_SOURCE).not.toContain("const allowedCommands = [");
	});

	test("worker does NOT have a local validatePath function", () => {
		// Path validation is now handled by executeTool internally
		expect(WORKER_SOURCE).not.toMatch(/function validatePath/);
	});
});

// ---------------------------------------------------------------------------
// ALLOWED_GIT_COMMANDS consistency
// ---------------------------------------------------------------------------
describe("ALLOWED_GIT_COMMANDS", () => {
	test("contains all expected read-only git subcommands", () => {
		const expected = ["log", "show", "blame", "diff", "shortlog", "describe", "rev-parse", "ls-tree", "cat-file"];
		for (const cmd of expected) {
			expect(ALLOWED_GIT_COMMANDS.has(cmd)).toBe(true);
		}
		expect(ALLOWED_GIT_COMMANDS.size).toBe(expected.length);
	});

	test("does NOT contain write commands", () => {
		const writeCommands = ["push", "fetch", "pull", "merge", "rebase", "commit", "checkout", "branch", "tag"];
		for (const cmd of writeCommands) {
			expect(ALLOWED_GIT_COMMANDS.has(cmd)).toBe(false);
		}
	});
});
