/**
 * Client for the sandbox worker service.
 *
 * The orchestrator uses this to delegate git cloning and tool execution
 * to the isolated container. Communicates over HTTP on the compose internal network.
 */

import { type Logger, nullLogger } from "../logger";

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
	private logger: Logger;

	constructor(config: SandboxClientConfig, logger: Logger = nullLogger) {
		this.config = config;
		this.logger = logger;
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
		let attempt = 0;
		while (Date.now() - start < maxWaitMs) {
			attempt++;
			if (await this.health()) {
				this.logger.debug("sandbox:client", `healthy after ${attempt} attempt(s) (${Date.now() - start}ms)`);
				return;
			}
			this.logger.debug("sandbox:client", `waitForReady attempt ${attempt} failed, retrying in ${Math.round(delay)}ms`);
			await Bun.sleep(delay);
			delay = Math.min(delay * 1.5, 3000);
		}
		throw new Error(`Sandbox worker not ready after ${maxWaitMs}ms`);
	}

	/** Clone a repository inside the sandbox. */
	async clone(url: string, commitish?: string): Promise<CloneResult> {
		this.logger.debug("sandbox:client", `POST /clone url=${url} commitish=${commitish ?? "HEAD"}`);
		const t0 = Date.now();

		const res = await fetch(`${this.config.baseUrl}/clone`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.authHeaders() },
			body: JSON.stringify({ url, commitish }),
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});

		const body = (await res.json()) as { ok: boolean; error?: string } & CloneResult;
		const duration = Date.now() - t0;

		if (!body.ok) {
			this.logger.error("sandbox:client", new Error(`POST /clone → ${res.status} (${duration}ms): ${body.error}`));
			throw new Error(`Sandbox clone failed: ${body.error}`);
		}

		this.logger.debug(
			"sandbox:client",
			`POST /clone → ${res.status} (${duration}ms) slug=${body.slug} sha=${body.sha.slice(0, 12)}`,
		);
		return { slug: body.slug, sha: body.sha, worktree: body.worktree };
	}

	/** Execute a tool inside the sandbox against a previously-cloned repo. */
	async executeTool(slug: string, sha: string, name: string, args: Record<string, unknown>): Promise<string> {
		this.logger.debug("sandbox:client", `POST /tool slug=${slug} sha=${sha.slice(0, 12)} name=${name}`);
		const t0 = Date.now();

		const res = await fetch(`${this.config.baseUrl}/tool`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.authHeaders() },
			body: JSON.stringify({ slug, sha, name, args }),
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});

		const body = (await res.json()) as { ok: boolean; output?: string; error?: string };
		const duration = Date.now() - t0;

		if (!body.ok) {
			this.logger.warn("sandbox:client", `POST /tool ${name} → ${res.status} (${duration}ms): ${body.error}`);
			return `Error: ${body.error}`;
		}

		this.logger.debug("sandbox:client", `POST /tool ${name} → ${res.status} (${duration}ms)`);
		return body.output ?? "(no output)";
	}

	/** Delete all cloned repos in the sandbox. */
	async reset(): Promise<void> {
		this.logger.debug("sandbox:client", "POST /reset");
		const t0 = Date.now();

		const res = await fetch(`${this.config.baseUrl}/reset`, {
			method: "POST",
			headers: { ...this.authHeaders() },
			signal: AbortSignal.timeout(10_000),
		});

		const body = (await res.json()) as { ok: boolean; error?: string };
		const duration = Date.now() - t0;

		if (!body.ok) {
			this.logger.error("sandbox:client", new Error(`POST /reset → ${res.status} (${duration}ms): ${body.error}`));
			throw new Error(`Sandbox reset failed: ${body.error}`);
		}

		this.logger.debug("sandbox:client", `POST /reset → ${res.status} (${duration}ms)`);
	}
}
