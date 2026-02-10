/**
 * Security isolation primitives using bwrap (bubblewrap) and seccomp.
 *
 * Provides two levels of isolation:
 *   - bwrap: filesystem and PID namespace isolation
 *   - seccomp: BPF filter to block network syscalls
 */

/** Path to seccomp BPF filter that blocks network sockets */
const SECCOMP_FILTER = "/etc/seccomp/net-block.bpf";
/** Path to apply-seccomp binary */
const APPLY_SECCOMP = "/usr/local/bin/apply-seccomp";

/**
 * Build bwrap args for git operations.
 *
 * - Filesystem: read-only root, writable repo directory
 * - PID: isolated
 * - Network: allowed (git needs to fetch)
 */
export function bwrapArgsForGit(repoBaseDir: string): string[] {
	return [
		"bwrap",
		"--ro-bind",
		"/",
		"/",
		"--bind",
		repoBaseDir,
		repoBaseDir,
		"--tmpfs",
		"/tmp",
		"--dev",
		"/dev",
		"--unshare-pid",
		"--die-with-parent",
		"--",
	];
}

/**
 * Build bwrap args for tool execution.
 *
 * - Filesystem: read-only root, only specific worktree visible
 * - PID: isolated
 * - Network: blocked via seccomp (applied separately)
 */
export function bwrapArgsForTool(worktree: string, repoBase: string): string[] {
	return [
		"bwrap",
		"--ro-bind",
		"/",
		"/",
		"--tmpfs",
		repoBase,
		"--ro-bind",
		worktree,
		worktree,
		"--dev",
		"/dev",
		"--unshare-pid",
		"--die-with-parent",
		"--",
	];
}

/**
 * Build bwrap args for read-only git commands in a worktree.
 *
 * Git worktrees need access to their parent bare repo, so we mount:
 * - worktree: read-only
 * - bare repo: read-only (for .git references)
 *
 * Network is blocked via seccomp.
 */
export function bwrapArgsForGitTool(worktree: string, bareRepo: string, repoBase: string): string[] {
	return [
		"bwrap",
		"--ro-bind",
		"/",
		"/",
		"--tmpfs",
		repoBase,
		"--ro-bind",
		worktree,
		worktree,
		"--ro-bind",
		bareRepo,
		bareRepo,
		"--dev",
		"/dev",
		"--unshare-pid",
		"--die-with-parent",
		"--",
	];
}

/**
 * Wrap a command with seccomp to block network syscalls.
 * Blocks socket(AF_INET, ...) and socket(AF_INET6, ...).
 */
export function withSeccomp(cmd: string[]): string[] {
	return [APPLY_SECCOMP, SECCOMP_FILTER, ...cmd];
}

/**
 * Build full isolated command for tool execution.
 * Combines bwrap (filesystem/PID isolation) with seccomp (network blocking).
 */
export function isolatedToolCommand(cmd: string[], worktree: string, repoBase: string): string[] {
	return [...bwrapArgsForTool(worktree, repoBase), ...withSeccomp(cmd)];
}

/**
 * Build isolated command for read-only git operations in a worktree.
 * Mounts both worktree and bare repo read-only, blocks network.
 */
export function isolatedGitToolCommand(cmd: string[], worktree: string, bareRepo: string, repoBase: string): string[] {
	return [...bwrapArgsForGitTool(worktree, bareRepo, repoBase), ...withSeccomp(cmd)];
}

/**
 * Build full isolated command for git operations.
 * Uses bwrap for filesystem/PID isolation but allows network access.
 */
export function isolatedGitCommand(gitArgs: string[], repoBaseDir: string): string[] {
	return [
		...bwrapArgsForGit(repoBaseDir),
		"git",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"filter.lfs.process=",
		"-c",
		"filter.lfs.smudge=",
		"-c",
		"filter.lfs.clean=",
		"-c",
		"filter.lfs.required=false",
		"-c",
		"protocol.allow=never",
		"-c",
		"protocol.https.allow=always",
		"-c",
		"protocol.http.allow=always",
		...gitArgs,
	];
}
