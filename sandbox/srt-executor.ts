/**
 * Sandbox tool executor using Anthropic's Sandbox Runtime (srt).
 *
 * Uses OS-level sandboxing (bubblewrap on Linux, sandbox-exec on macOS) to
 * isolate tool execution. Each tool command is wrapped with filesystem and
 * network restrictions:
 *   - Read-only access to the worktree (no writes anywhere)
 *   - No network access
 *   - Sensitive paths denied (e.g., ~/.ssh)
 */

import { resolve } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

let initialized = false;

/**
 * Default sandbox config: no network, no writes, deny sensitive paths.
 */
function buildConfig(_worktree: string): Partial<SandboxRuntimeConfig> {
	return {
		network: {
			allowedDomains: [],
			deniedDomains: [],
		},
		filesystem: {
			denyRead: ["~/.ssh", "~/.gnupg", "~/.aws", "~/.config"],
			allowWrite: [],
			denyWrite: [],
		},
	};
}

/**
 * Initialize the SandboxManager once per process.
 */
async function ensureInitialized(): Promise<void> {
	if (initialized) return;

	const config: SandboxRuntimeConfig = {
		network: {
			allowedDomains: [],
			deniedDomains: [],
		},
		filesystem: {
			denyRead: ["~/.ssh", "~/.gnupg", "~/.aws", "~/.config"],
			allowWrite: [],
			denyWrite: [],
		},
	};

	await SandboxManager.initialize(config);
	initialized = true;
}

/**
 * Run a command inside the sandbox and return its stdout.
 */
async function runSandboxed(cmd: string[], cwd: string): Promise<string> {
	await ensureInitialized();

	// Build the shell command string
	const shellCmd = cmd.map(shellEscape).join(" ");

	// Wrap with sandbox restrictions (read-only worktree, no network)
	const wrappedCmd = await SandboxManager.wrapWithSandbox(shellCmd, undefined, buildConfig(cwd));

	const proc = Bun.spawn(["sh", "-c", `cd ${shellEscape(cwd)} && ${wrappedCmd}`], {
		stdout: "pipe",
		stderr: "pipe",
		cwd,
	});

	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		return `Error (exit ${exitCode}):\n${stderr}`;
	}
	return stdout || "(no output)";
}

/**
 * Shell-escape a single argument.
 */
function shellEscape(arg: string): string {
	if (/^[a-zA-Z0-9._\-/=:@]+$/.test(arg)) {
		return arg;
	}
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate that a resolved path stays within the worktree root.
 */
function validatePath(worktree: string, userPath: string): string | null {
	const full = resolve(worktree, userPath);
	if (!full.startsWith(resolve(worktree))) {
		return null;
	}
	return full;
}

/**
 * Execute a tool inside the Anthropic sandbox runtime.
 */
export async function executeSandboxedTool(
	toolName: string,
	args: Record<string, unknown>,
	worktree: string,
): Promise<string> {
	if (toolName === "rg") {
		const pattern = args.pattern as string;
		const glob = args.glob as string | undefined;
		const cmd = ["rg", "--line-number", pattern];
		if (glob) cmd.push("--glob", glob);
		return runSandboxed(cmd, worktree);
	}

	if (toolName === "fd") {
		const pattern = args.pattern as string;
		const type = args.type as "f" | "d" | undefined;
		const cmd = ["find", ".", "-name", `*${pattern}*`];
		if (type === "f") cmd.push("-type", "f");
		else if (type === "d") cmd.push("-type", "d");
		return runSandboxed(cmd, worktree);
	}

	if (toolName === "ls") {
		const path = (args.path as string | undefined) || ".";
		const fullPath = validatePath(worktree, path);
		if (!fullPath) {
			return `Error: path traversal not allowed: ${path}`;
		}
		return runSandboxed(["ls", "-la", fullPath], worktree);
	}

	if (toolName === "read") {
		const filePath = args.path as string;
		const fullPath = validatePath(worktree, filePath);
		if (!fullPath) {
			return `Error reading file: path traversal not allowed: ${filePath}`;
		}
		return runSandboxed(["cat", fullPath], worktree);
	}

	return `Unknown tool: ${toolName}`;
}

/**
 * Clean up the sandbox manager (call on process exit).
 */
export async function resetSandbox(): Promise<void> {
	if (initialized) {
		await SandboxManager.reset();
		initialized = false;
	}
}
