/**
 * Sandbox module — isolated git and tool execution.
 *
 * Components:
 *   - SandboxClient: HTTP client for the sandbox worker
 *   - worker.ts: HTTP server (runs in container)
 *   - isolation/: Security primitives (bwrap, seccomp)
 *
 * Usage:
 *   import { SandboxClient } from "./sandbox";
 *   const client = new SandboxClient({ baseUrl: "http://localhost:8080" });
 *   const { slug, sha } = await client.clone("https://github.com/owner/repo");
 *   const output = await client.executeTool(slug, sha, "rg", { pattern: "TODO" });
 */

export { SandboxClient, type SandboxClientConfig, type CloneResult } from "./client";
export * as isolation from "./isolation";
