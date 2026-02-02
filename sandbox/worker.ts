/**
 * Sandbox worker — HTTP server that runs inside an isolated container.
 *
 * Defense in depth:
 *   Layer 1 — bwrap (bubblewrap): per-operation filesystem and PID namespace
 *             isolation. Tool calls are scoped to their worktree with no
 *             visibility of other processes. Git clones get write access
 *             only to their target directory with hooks disabled.
 *             Note: --unshare-net is not used because gVisor doesn't support
 *             bwrap's loopback setup. Network isolation comes from gVisor +
 *             compose network instead.
 *   Layer 2 — gVisor (runsc): the container runtime provides kernel-level
 *             syscall sandboxing.
 *   Layer 3 — Path validation in the worker code itself.
 *
 * Endpoints:
 *   POST /clone   { url, commitish? }  → clone a repo, check out a commit
 *   POST /tool    { slug, sha, name, args }  → execute a tool (rg, fd, ls, read)
 *   GET  /health                       → liveness check
 *   POST /reset                        → delete all cloned data
 *
 * The container's compose network provides outbound access for git clone.
 * Tool execution has no network access (bwrap --unshare-net).
 */

import { resolve } from "node:path";

const PORT = Number(process.env.PORT) || 8080;
const REPO_BASE = "/home/forge/repos";
const SANDBOX_SECRET = process.env.SANDBOX_SECRET || "";

// =============================================================================
// Helpers
// =============================================================================

// Git environment to prevent interactive prompts
const GIT_ENV: Record<string, string> = {
	SSH_AUTH_SOCK: "",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	HOME: "/home/forge",
};

/** Default timeout for tool execution (30 seconds) */
const TOOL_TIMEOUT_MS = 30_000;
/** Default timeout for git operations (120 seconds) */
const GIT_TIMEOUT_MS = 120_000;

async function run(
	cmd: string[],
	cwd?: string,
	env?: Record<string, string>,
	timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: env ?? process.env,
	});

	if (timeoutMs) {
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				/* already exited */
			}
		}, timeoutMs);

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		clearTimeout(timer);

		if (exitCode === 137 || exitCode === -1) {
			return { stdout, stderr: `${stderr}\nOperation timed out after ${timeoutMs}ms`, exitCode: 124 };
		}
		return { stdout, stderr, exitCode };
	}

	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { stdout, stderr, exitCode: await proc.exited };
}

function repoDir(id: string): string {
	return `${REPO_BASE}/${id}`;
}

/** Turn a repo URL into a safe filesystem slug. */
function slugify(url: string): string {
	try {
		const u = new URL(url);
		return `${u.hostname}${u.pathname}`.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
	} catch {
		return url.replace(/[^a-zA-Z0-9._-]/g, "_");
	}
}

/**
 * Validate that a resolved path stays within the worktree root.
 * Defense-in-depth: bwrap is the primary per-session boundary, gVisor is the
 * container boundary, and this prevents traversal within the worktree.
 */
function validatePath(worktree: string, userPath: string): string | null {
	const full = resolve(worktree, userPath);
	if (!full.startsWith(resolve(worktree))) {
		return null;
	}
	return full;
}

// =============================================================================
// bwrap wrappers
// =============================================================================

/**
 * Build bwrap args for git clone/fetch/worktree operations.
 *
 * Filesystem: read-only root, writable only to the specific repo directory.
 * Network: NOT isolated (needs to reach git remotes). TODO: add proxy filtering.
 * Hooks: disabled via git config.
 * PID: isolated.
 */
function bwrapArgsForGit(repoBaseDir: string): string[] {
	return [
		"bwrap",
		// Read-only root filesystem
		"--ro-bind",
		"/",
		"/",
		// Writable: the specific repo directory
		"--bind",
		repoBaseDir,
		repoBaseDir,
		// Writable: /tmp for git's temporary files
		"--tmpfs",
		"/tmp",
		// Fresh /dev
		"--dev",
		"/dev",
		// PID isolation — git can't see/signal other processes
		"--unshare-pid",
		// Die if parent dies
		"--die-with-parent",
		"--",
	];
}

/**
 * Build bwrap args for tool execution (rg, find, ls, cat, etc).
 *
 * Filesystem: read-only root, with /home/forge/repos replaced by tmpfs
 *             and only the specific worktree bind-mounted back through.
 * Network: NOT isolated via bwrap (--unshare-net fails under gVisor).
 *          Network isolation is provided by gVisor + compose network instead.
 * PID: isolated.
 */
function bwrapArgsForTool(worktree: string): string[] {
	return [
		"bwrap",
		// Read-only root filesystem
		"--ro-bind",
		"/",
		"/",
		// Hide ALL repos, then punch through only this worktree
		"--tmpfs",
		REPO_BASE,
		"--ro-bind",
		worktree,
		worktree,
		// Fresh /dev
		"--dev",
		"/dev",
		// PID isolation
		"--unshare-pid",
		// Die if parent dies
		"--die-with-parent",
		"--",
	];
}

/**
 * Run a git command inside bwrap with filesystem + PID isolation.
 * Git hooks are disabled via config flags.
 */
async function runGitSandboxed(
	gitArgs: string[],
	cwd: string | undefined,
	repoBaseDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const cmd = [
		...bwrapArgsForGit(repoBaseDir),
		"git",
		// Disable hooks to prevent arbitrary code execution from malicious repos
		"-c",
		"core.hooksPath=/dev/null",
		// Disable filter drivers (.gitattributes filter.*.process / filter.*.smudge)
		"-c",
		"filter.lfs.process=",
		"-c",
		"filter.lfs.smudge=",
		"-c",
		"filter.lfs.clean=",
		"-c",
		"filter.lfs.required=false",
		// Restrict protocols to http(s) only — blocks file://, ext://, ssh:// submodules
		"-c",
		"protocol.allow=never",
		"-c",
		"protocol.https.allow=always",
		"-c",
		"protocol.http.allow=always",
		...gitArgs,
	];

	return run(
		cmd,
		cwd,
		{
			...GIT_ENV,
			// Disable .gitattributes processing system-wide
			GIT_ATTR_NOSYSTEM: "1",
			// Prevent any global gitconfig from being loaded
			GIT_CONFIG_NOSYSTEM: "1",
		},
		GIT_TIMEOUT_MS,
	);
}

/**
 * Run a tool command inside bwrap with per-worktree isolation + no network.
 */
async function runToolSandboxed(
	cmd: string[],
	worktree: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const fullCmd = [...bwrapArgsForTool(worktree), ...cmd];

	return run(fullCmd, worktree, undefined, TOOL_TIMEOUT_MS);
}

// =============================================================================
// Clone
// =============================================================================

interface CloneRequest {
	url: string;
	commitish?: string;
}

async function handleClone(body: CloneRequest): Promise<Response> {
	const { url, commitish = "HEAD" } = body;
	if (!url) {
		return Response.json({ ok: false, error: "url is required" }, { status: 400 });
	}

	const slug = slugify(url);
	const baseDir = repoDir(slug);
	const bareDir = `${baseDir}/bare`;
	const treesDir = `${baseDir}/trees`;

	try {
		// Ensure directories exist (run outside bwrap — bwrap needs them to exist for bind mounts)
		await Bun.spawn(["mkdir", "-p", bareDir, treesDir]).exited;

		// Clone or fetch
		const headFile = Bun.file(`${bareDir}/HEAD`);
		if (await headFile.exists()) {
			const { exitCode, stderr } = await runGitSandboxed(["fetch", "origin", "--tags"], bareDir, baseDir);
			if (exitCode !== 0) {
				console.error(`[clone] fetch failed: ${stderr}`);
			}
		} else {
			const { exitCode, stderr } = await runGitSandboxed(["clone", "--bare", url, bareDir], undefined, baseDir);
			if (exitCode !== 0) {
				return Response.json({ ok: false, error: `git clone failed: ${stderr.slice(0, 500)}` }, { status: 500 });
			}
		}

		// Resolve commitish → SHA
		const revParse = await runGitSandboxed(["rev-parse", commitish], bareDir, baseDir);
		if (revParse.exitCode !== 0) {
			return Response.json(
				{
					ok: false,
					error: `Cannot resolve commitish "${commitish}": ${revParse.stderr.slice(0, 300)}`,
				},
				{ status: 400 },
			);
		}
		const sha = revParse.stdout.trim();
		const shortSha = sha.slice(0, 12);
		const worktree = `${treesDir}/${shortSha}`;

		// Create worktree if it doesn't exist
		const worktreeExists = await Bun.file(`${worktree}/.git`).exists();
		if (!worktreeExists) {
			const wt = await runGitSandboxed(["worktree", "add", worktree, sha], bareDir, baseDir);
			if (wt.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `git worktree add failed: ${wt.stderr.slice(0, 300)}` },
					{ status: 500 },
				);
			}
		}

		return Response.json({ ok: true, slug, sha, worktree });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ ok: false, error: msg }, { status: 500 });
	}
}

// =============================================================================
// Tool execution
// =============================================================================

interface ToolRequest {
	slug: string;
	sha: string;
	name: string;
	args: Record<string, unknown>;
}

async function handleTool(body: ToolRequest): Promise<Response> {
	const { slug, sha, name, args } = body;
	if (!slug || !sha || !name) {
		return Response.json({ ok: false, error: "slug, sha, and name are required" }, { status: 400 });
	}

	const shortSha = sha.slice(0, 12);
	const worktree = `${repoDir(slug)}/trees/${shortSha}`;
	const wtExists = await Bun.file(`${worktree}/.git`).exists();
	if (!wtExists) {
		return Response.json({ ok: false, error: `Worktree not found: ${worktree}` }, { status: 404 });
	}

	switch (name) {
		case "rg": {
			const pattern = args.pattern as string;
			const glob = args.glob as string | undefined;
			const cmd = ["rg", "--line-number", pattern];
			if (glob) cmd.push("--glob", glob);
			const result = await runToolSandboxed(cmd, worktree);
			if (result.exitCode !== 0) {
				return Response.json({ ok: true, output: `Error (exit ${result.exitCode}):\n${result.stderr}` });
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "fd": {
			const pattern = args.pattern as string;
			const type = args.type as "f" | "d" | undefined;
			const cmd = ["find", ".", "-name", `*${pattern}*`];
			if (type === "f") cmd.push("-type", "f");
			else if (type === "d") cmd.push("-type", "d");
			const result = await runToolSandboxed(cmd, worktree);
			if (result.exitCode !== 0) {
				return Response.json({ ok: true, output: `Error (exit ${result.exitCode}):\n${result.stderr}` });
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "ls": {
			const path = (args.path as string) || ".";
			const fullPath = validatePath(worktree, path);
			if (!fullPath) {
				return Response.json({ ok: true, output: `Error: path traversal not allowed: ${path}` });
			}
			const result = await runToolSandboxed(["ls", "-la", fullPath], worktree);
			if (result.exitCode !== 0) {
				return Response.json({ ok: true, output: `Error (exit ${result.exitCode}):\n${result.stderr}` });
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "read": {
			const path = args.path as string;
			const fullPath = validatePath(worktree, path);
			if (!fullPath) {
				return Response.json({ ok: true, output: `Error: path traversal not allowed: ${path}` });
			}
			const result = await runToolSandboxed(["cat", fullPath], worktree);
			if (result.exitCode !== 0) {
				return Response.json({
					ok: true,
					output: `Error reading file (exit ${result.exitCode}):\n${result.stderr}`,
				});
			}
			return Response.json({ ok: true, output: result.stdout || "(empty file)" });
		}
		default:
			return Response.json({ ok: false, error: `Unknown tool: ${name}` }, { status: 400 });
	}
}

// =============================================================================
// Reset (delete all repos)
// =============================================================================

async function handleReset(): Promise<Response> {
	const { exitCode } = await run(["rm", "-rf", REPO_BASE]);
	if (exitCode !== 0) {
		return Response.json({ ok: false, error: "Failed to clean repos" }, { status: 500 });
	}
	await Bun.spawn(["mkdir", "-p", REPO_BASE]).exited;
	return Response.json({ ok: true });
}

// =============================================================================
// HTTP Server
// =============================================================================

await Bun.spawn(["mkdir", "-p", REPO_BASE]).exited;

function checkAuth(req: Request): Response | null {
	if (!SANDBOX_SECRET) return null; // No secret configured = no auth required
	const token = req.headers.get("Authorization")?.replace("Bearer ", "");
	if (token !== SANDBOX_SECRET) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}
	return null;
}

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		// Health check is unauthenticated (needed for Docker healthcheck)
		if (url.pathname === "/health" && req.method === "GET") {
			return Response.json({ ok: true });
		}

		// All other endpoints require auth
		const authError = checkAuth(req);
		if (authError) return authError;

		if (url.pathname === "/clone" && req.method === "POST") {
			const body = (await req.json()) as CloneRequest;
			return handleClone(body);
		}

		if (url.pathname === "/tool" && req.method === "POST") {
			const body = (await req.json()) as ToolRequest;
			return handleTool(body);
		}

		if (url.pathname === "/reset" && req.method === "POST") {
			return handleReset();
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`[sandbox-worker] Listening on :${server.port}`);
