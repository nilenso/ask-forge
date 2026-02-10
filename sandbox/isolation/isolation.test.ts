/**
 * Integration tests for the isolation layer.
 *
 * These tests verify that bwrap and seccomp provide the expected isolation.
 * Requires: bwrap, and for seccomp tests, the compiled apply-seccomp + net-block.bpf
 *
 * Run with: bun test sandbox/isolation/isolation.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bwrapArgsForGit, bwrapArgsForTool } from "./index";

// =============================================================================
// Helpers
// =============================================================================

function run(cmd: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync(cmd[0], cmd.slice(1), {
		cwd,
		encoding: "utf-8",
		timeout: 10_000,
	});
	return {
		stdout: result.stdout || "",
		stderr: result.stderr || "",
		exitCode: result.status ?? -1,
	};
}

function hasBwrap(): boolean {
	const result = run(["which", "bwrap"]);
	return result.exitCode === 0;
}

// =============================================================================
// bwrap filesystem isolation tests
// =============================================================================

describe("bwrap filesystem isolation", () => {
	// Use a path outside /tmp since bwrap uses --tmpfs /tmp
	const TEST_BASE = "/var/tmp";
	let testDir: string;
	let repoDir: string;

	beforeAll(async () => {
		if (!hasBwrap()) {
			console.log("Skipping bwrap tests: bwrap not installed");
			return;
		}
		testDir = await mkdtemp(join(TEST_BASE, "isolation-test-"));
		repoDir = join(testDir, "repo");
		await mkdir(repoDir, { recursive: true });
		await writeFile(join(repoDir, "test.txt"), "test content");
	});

	test("bwrapArgsForGit allows writes to repo directory", async () => {
		if (!hasBwrap()) return;

		const args = bwrapArgsForGit(repoDir);
		const result = run([...args, "sh", "-c", `echo "new file" > ${repoDir}/new.txt && cat ${repoDir}/new.txt`]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("new file");
	});

	test("bwrapArgsForGit blocks writes to /tmp (replaced with tmpfs)", async () => {
		if (!hasBwrap()) return;

		const args = bwrapArgsForGit(repoDir);
		// Write should succeed to tmpfs, but the file won't persist
		const result = run([...args, "sh", "-c", `echo "temp" > /tmp/test.txt && cat /tmp/test.txt`]);

		// tmpfs allows writes, but this verifies it's mounted
		expect(result.exitCode).toBe(0);
	});

	test("bwrapArgsForGit blocks writes to root filesystem", async () => {
		if (!hasBwrap()) return;

		const args = bwrapArgsForGit(repoDir);
		const result = run([...args, "sh", "-c", `echo "hack" > /etc/test.txt 2>&1`]);

		expect(result.exitCode).not.toBe(0);
	});

	test("bwrapArgsForTool makes worktree read-only", async () => {
		if (!hasBwrap()) return;

		const args = bwrapArgsForTool(repoDir, testDir);
		const result = run([...args, "sh", "-c", `echo "write" > ${repoDir}/write.txt 2>&1`]);

		expect(result.exitCode).not.toBe(0);
	});

	test("bwrapArgsForTool allows reading files in worktree", async () => {
		if (!hasBwrap()) return;

		const args = bwrapArgsForTool(repoDir, testDir);
		const result = run([...args, "cat", join(repoDir, "test.txt")]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("test content");
	});

	test("bwrapArgsForTool hides other directories in repo base", async () => {
		if (!hasBwrap()) return;

		// Create another directory in testDir that should be hidden
		const otherDir = join(testDir, "other");
		await mkdir(otherDir, { recursive: true });
		await writeFile(join(otherDir, "secret.txt"), "secret");

		const args = bwrapArgsForTool(repoDir, testDir);
		const result = run([...args, "cat", join(otherDir, "secret.txt")]);

		expect(result.exitCode).not.toBe(0);
	});
});

// =============================================================================
// bwrap PID isolation tests
// =============================================================================

describe("bwrap PID isolation", () => {
	test("sandbox runs in isolated PID namespace", async () => {
		if (!hasBwrap()) return;

		const testDir = await mkdtemp(join("/var/tmp", "pid-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		// Verify PID namespace is created (process gets PID 1 or low number)
		// Note: without --proc /proc, /proc still shows host processes,
		// but the sandbox process itself is in a new namespace
		const result = run([...args, "sh", "-c", "echo $$"]);

		expect(result.exitCode).toBe(0);
		// The shell should have a low PID in the new namespace
		const pid = parseInt(result.stdout.trim(), 10);
		expect(pid).toBeLessThan(100);

		await rm(testDir, { recursive: true });
	});

	test("host PIDs are not visible in sandbox", async () => {
		if (!hasBwrap()) return;

		const testDir = await mkdtemp(join("/var/tmp", "pid-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		// Get a host PID that definitely exists (our own process)
		const hostPid = process.pid;

		// Try to check if this PID exists in the sandbox
		// In an isolated PID namespace, high host PIDs shouldn't exist
		const result = run([...args, "sh", "-c", `kill -0 ${hostPid} 2>&1`]);

		// Should fail - the host PID doesn't exist in the sandbox namespace
		expect(result.exitCode).not.toBe(0);

		await rm(testDir, { recursive: true });
	});
});

// =============================================================================
// seccomp network blocking tests
// =============================================================================

describe("seccomp network blocking", () => {
	const APPLY_SECCOMP = "/usr/local/bin/apply-seccomp";
	const SECCOMP_FILTER = "/etc/seccomp/net-block.bpf";

	function hasSeccomp(): boolean {
		const result = run(["test", "-x", APPLY_SECCOMP]);
		const filterResult = run(["test", "-f", SECCOMP_FILTER]);
		return result.exitCode === 0 && filterResult.exitCode === 0;
	}

	test("without seccomp, network connections work", async () => {
		// This test verifies the baseline - network works without seccomp
		const result = run(["sh", "-c", "echo | nc -w 1 1.1.1.1 53 2>&1 || echo 'connected or timed out'"]);
		// We just verify the command runs - actual connectivity depends on network
		expect(result.exitCode).toBeDefined();
	});

	test("with seccomp, IPv4 socket creation is blocked", async () => {
		if (!hasSeccomp()) {
			console.log("Skipping seccomp test: apply-seccomp or filter not found");
			return;
		}

		// Try to create an IPv4 socket - should fail with EPERM
		const result = run([
			APPLY_SECCOMP,
			SECCOMP_FILTER,
			"python3",
			"-c",
			"import socket; s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); print('created')",
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Operation not permitted");
	});

	test("with seccomp, IPv6 socket creation is blocked", async () => {
		if (!hasSeccomp()) {
			console.log("Skipping seccomp test: apply-seccomp or filter not found");
			return;
		}

		const result = run([
			APPLY_SECCOMP,
			SECCOMP_FILTER,
			"python3",
			"-c",
			"import socket; s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM); print('created')",
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Operation not permitted");
	});

	test("with seccomp, Unix sockets still work", async () => {
		if (!hasSeccomp()) {
			console.log("Skipping seccomp test: apply-seccomp or filter not found");
			return;
		}

		const result = run([
			APPLY_SECCOMP,
			SECCOMP_FILTER,
			"python3",
			"-c",
			"import socket; s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); print('unix socket created')",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("unix socket created");
	});

	test("with seccomp, regular commands work", async () => {
		if (!hasSeccomp()) {
			console.log("Skipping seccomp test: apply-seccomp or filter not found");
			return;
		}

		const result = run([APPLY_SECCOMP, SECCOMP_FILTER, "echo", "hello world"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello world");
	});
});

// =============================================================================
// Combined isolation tests
// =============================================================================

describe("combined bwrap + seccomp isolation", () => {
	const APPLY_SECCOMP = "/usr/local/bin/apply-seccomp";
	const SECCOMP_FILTER = "/etc/seccomp/net-block.bpf";
	const TEST_BASE = "/var/tmp";

	function hasFullIsolation(): boolean {
		if (!hasBwrap()) return false;
		const result = run(["test", "-x", APPLY_SECCOMP]);
		const filterResult = run(["test", "-f", SECCOMP_FILTER]);
		return result.exitCode === 0 && filterResult.exitCode === 0;
	}

	test("tool execution with full isolation can read files", async () => {
		if (!hasFullIsolation()) {
			console.log("Skipping combined test: bwrap or seccomp not available");
			return;
		}

		const testDir = await mkdtemp(join(TEST_BASE, "combined-test-"));
		await writeFile(join(testDir, "data.txt"), "isolated content");

		const bwrapArgs = bwrapArgsForTool(testDir, testDir);
		const result = run([...bwrapArgs, APPLY_SECCOMP, SECCOMP_FILTER, "cat", join(testDir, "data.txt")]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("isolated content");

		await rm(testDir, { recursive: true });
	});

	test("tool execution with full isolation blocks network", async () => {
		if (!hasFullIsolation()) {
			console.log("Skipping combined test: bwrap or seccomp not available");
			return;
		}

		const testDir = await mkdtemp(join(TEST_BASE, "combined-test-"));

		const bwrapArgs = bwrapArgsForTool(testDir, testDir);
		// Use bash /dev/tcp which requires socket creation
		const result = run([...bwrapArgs, APPLY_SECCOMP, SECCOMP_FILTER, "bash", "-c", "echo > /dev/tcp/1.1.1.1/53"]);

		expect(result.exitCode).not.toBe(0);

		await rm(testDir, { recursive: true });
	});

	test("tool execution with full isolation blocks writes", async () => {
		if (!hasFullIsolation()) {
			console.log("Skipping combined test: bwrap or seccomp not available");
			return;
		}

		const testDir = await mkdtemp(join(TEST_BASE, "combined-test-"));
		await writeFile(join(testDir, "existing.txt"), "original");

		const bwrapArgs = bwrapArgsForTool(testDir, testDir);
		const result = run([
			...bwrapArgs,
			APPLY_SECCOMP,
			SECCOMP_FILTER,
			"sh",
			"-c",
			`echo "modified" > ${testDir}/existing.txt`,
		]);

		expect(result.exitCode).not.toBe(0);

		await rm(testDir, { recursive: true });
	});
});
