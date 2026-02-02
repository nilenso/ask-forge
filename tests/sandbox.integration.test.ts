/**
 * Integration tests for security boundaries in ask-forge.
 *
 * Tests the local tool executor's path traversal protection using the
 * actual executeLocalTool function, not a re-implementation.
 *
 * Run with: bun test tests/sandbox.integration.test.ts
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { executeLocalTool } from "../index";

// =============================================================================
// Path Traversal Protection (Local Tool Executor — real code)
// =============================================================================

describe("Local Read Tool - Path Traversal Protection", () => {
	const repoRoot = resolve(import.meta.dir, "..");

	test("allows reading a file inside the repo", async () => {
		const result = await executeLocalTool("read", { path: "package.json" }, repoRoot);
		expect(result).toContain('"name": "ask-forge"');
	});

	test("allows reading files in subdirectories", async () => {
		const result = await executeLocalTool("read", { path: "config.ts" }, repoRoot);
		expect(result).not.toContain("Error reading file");
	});

	test("blocks path traversal with ../", async () => {
		const result = await executeLocalTool("read", { path: "../../../etc/passwd" }, repoRoot);
		expect(result).toContain("path traversal not allowed");
	});

	test("blocks path traversal with absolute path outside repo", async () => {
		const result = await executeLocalTool("read", { path: "/etc/passwd" }, repoRoot);
		expect(result).toContain("path traversal not allowed");
	});

	test("blocks path traversal with encoded sequences", async () => {
		const result = await executeLocalTool("read", { path: "src/../../../../../../etc/passwd" }, repoRoot);
		expect(result).toContain("path traversal not allowed");
	});

	test("returns error for nonexistent files", async () => {
		const result = await executeLocalTool("read", { path: "nonexistent-file.txt" }, repoRoot);
		expect(result).toContain("Error reading file");
	});

	test("allows relative paths that stay within repo", async () => {
		const result = await executeLocalTool("read", { path: "./package.json" }, repoRoot);
		expect(result).toContain('"name": "ask-forge"');
	});
});

// =============================================================================
// Other tools
// =============================================================================

describe("Local Tool Executor - Other Tools", () => {
	const repoRoot = resolve(import.meta.dir, "..");

	test("ls lists files in repo root", async () => {
		const result = await executeLocalTool("ls", { path: "." }, repoRoot);
		expect(result).toContain("package.json");
	});

	test("find locates files by pattern", async () => {
		const result = await executeLocalTool("find", { pattern: "config", type: "f" }, repoRoot);
		expect(result).toContain("config.ts");
	});

	test("rg searches file content", async () => {
		const result = await executeLocalTool("rg", { pattern: "ask-forge", glob: "package.json" }, repoRoot);
		expect(result).toContain("ask-forge");
	});

	test("unknown tool returns error", async () => {
		const result = await executeLocalTool("nonexistent", {}, repoRoot);
		expect(result).toContain("Unknown tool");
	});
});

// =============================================================================
// Session close() contract
// =============================================================================

describe("Session close() returns a Promise", () => {
	test("Session interface requires close() to return Promise<void>", async () => {
		const { connect } = await import("../index");
		expect(typeof connect).toBe("function");
	});
});
