/**
 * Client for the sandbox worker service.
 *
 * The orchestrator uses this to delegate git cloning and tool execution
 * to the isolated container. Communicates over HTTP on the compose internal network.
 */

export interface SandboxClientConfig {
	/** Base URL of the sandbox worker. */
	baseUrl: string;
	/** Request timeout in ms. */
	timeoutMs: number;
	/** Shared secret for authenticating with the sandbox worker. */
	secret?: string;
}

export interface CloneResult {
	slug: string;
	sha: string;
	worktree: string;
}

export class SandboxClient {
	private config: SandboxClientConfig;

	constructor(config: SandboxClientConfig) {
		this.config = config;
	}

	private authHeaders(): Record<string, string> {
		if (!this.config.secret) return {};
		return { Authorization: `Bearer ${this.config.secret}` };
	}

	/** Check if the sandbox worker is reachable. */
	async health(): Promise<boolean> {
		try {
			const res = await fetch(`${this.config.baseUrl}/health`, {
				signal: AbortSignal.timeout(5000),
			});
			const body = (await res.json()) as { ok: boolean };
			return body.ok === true;
		} catch {
			return false;
		}
	}

	/**
	 * Wait for the sandbox worker to become healthy.
	 * Retries with backoff up to maxWaitMs.
	 */
	async waitForReady(maxWaitMs = 30_000): Promise<void> {
		const start = Date.now();
		let delay = 200;
		while (Date.now() - start < maxWaitMs) {
			if (await this.health()) return;
			await Bun.sleep(delay);
			delay = Math.min(delay * 1.5, 3000);
		}
		throw new Error(`Sandbox worker not ready after ${maxWaitMs}ms`);
	}

	/** Clone a repository inside the sandbox. */
	async clone(url: string, commitish?: string): Promise<CloneResult> {
		const res = await fetch(`${this.config.baseUrl}/clone`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.authHeaders() },
			body: JSON.stringify({ url, commitish }),
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});

		const body = (await res.json()) as { ok: boolean; error?: string } & CloneResult;
		if (!body.ok) {
			throw new Error(`Sandbox clone failed: ${body.error}`);
		}
		return { slug: body.slug, sha: body.sha, worktree: body.worktree };
	}

	/** Execute a tool inside the sandbox against a previously-cloned repo. */
	async executeTool(slug: string, sha: string, name: string, args: Record<string, unknown>): Promise<string> {
		const res = await fetch(`${this.config.baseUrl}/tool`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.authHeaders() },
			body: JSON.stringify({ slug, sha, name, args }),
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});

		const body = (await res.json()) as { ok: boolean; output?: string; error?: string };
		if (!body.ok) {
			return `Error: ${body.error}`;
		}
		return body.output ?? "(no output)";
	}

	/** Delete all cloned repos in the sandbox. */
	async reset(): Promise<void> {
		const res = await fetch(`${this.config.baseUrl}/reset`, {
			method: "POST",
			headers: { ...this.authHeaders() },
			signal: AbortSignal.timeout(10_000),
		});
		const body = (await res.json()) as { ok: boolean; error?: string };
		if (!body.ok) {
			throw new Error(`Sandbox reset failed: ${body.error}`);
		}
	}
}
