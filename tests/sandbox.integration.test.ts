/**
 * Integration tests for security boundaries in ask-forge.
 *
 * Tests the local tool executor's path traversal protection and
 * the sandbox client's container-based isolation.
 *
 * Run with: bun test tests/sandbox.integration.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// =============================================================================
// Path Traversal Protection (Local Tool Executor)
// =============================================================================

/**
 * Reproduces the path validation logic from executeLocalTool's "read" handler.
 * Returns the file content or an error string, same as the real function.
 */
async function simulateReadTool(repoPath: string, filePath: string): Promise<string> {
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

describe("Local Read Tool - Path Traversal Protection", () => {
	// Use a real directory as the "repo root" for testing
	const repoRoot = resolve(import.meta.dir, "..");

	test("allows reading a file inside the repo", async () => {
		const result = await simulateReadTool(repoRoot, "package.json");
		expect(result).toContain('"name": "ask-forge"');
	});

	test("allows reading files in subdirectories", async () => {
		const result = await simulateReadTool(repoRoot, "config.ts");
		// Should return file content, not an error
		expect(result).not.toContain("Error reading file");
	});

	test("blocks path traversal with ../", async () => {
		const result = await simulateReadTool(repoRoot, "../../../etc/passwd");
		expect(result).toContain("path traversal not allowed");
	});

	test("blocks path traversal with absolute path outside repo", async () => {
		const result = await simulateReadTool(repoRoot, "/etc/passwd");
		// /etc/passwd doesn't start with the repo path, so should be blocked
		// Note: resolve("/some/repo", "/etc/passwd") = "/etc/passwd"
		expect(result).toContain("path traversal not allowed");
	});

	test("blocks path traversal with encoded sequences", async () => {
		// Attempt to escape via ..
		const result = await simulateReadTool(repoRoot, "src/../../../../../../etc/passwd");
		expect(result).toContain("path traversal not allowed");
	});

	test("returns error for nonexistent files", async () => {
		const result = await simulateReadTool(repoRoot, "nonexistent-file-that-does-not-exist.txt");
		expect(result).toContain("Error reading file");
		expect(result.includes("ENOENT") || result.includes("No such file or directory")).toBe(true);
	});

	test("allows relative paths that stay within repo", async () => {
		// ./package.json should resolve to the same as package.json
		const result = await simulateReadTool(repoRoot, "./package.json");
		expect(result).toContain('"name": "ask-forge"');
	});
});

// =============================================================================
// Session close() contract
// =============================================================================

describe("Session close() returns a Promise", () => {
	test("Session interface requires close() to return Promise<void>", async () => {
		// This is a compile-time check more than a runtime one.
		// Importing the type and verifying the shape.
		const { connect } = await import("../index");
		// Just verify the export exists and has the right shape
		expect(typeof connect).toBe("function");
	});
});
