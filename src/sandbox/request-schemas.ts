/**
 * TypeBox schemas + validators for sandbox worker HTTP request bodies.
 *
 * Separated from worker.ts so tests can import the validators without
 * triggering the top-level `Bun.serve` call that boots the HTTP server.
 *
 * Invariant: untrusted JSON should become trusted data exactly once, at
 * the HTTP boundary. Handlers in worker.ts operate only on the `Static`
 * types produced by these schemas — raw `req.json()` payloads must not be
 * cast to request types directly.
 */

import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

// =============================================================================
// Schemas
// =============================================================================

// `additionalProperties` is left at TypeBox's default (permissive) so that
// sandbox clients can evolve their payloads without tripping the validator.
// The fields we actually consume are the ones declared below.

export const CloneRequestSchema = Type.Object({
	url: Type.String({ minLength: 1, description: "Git repository URL to clone" }),
	commitish: Type.Optional(
		Type.String({ minLength: 1, description: "Branch, tag, or SHA to check out (defaults to HEAD)" }),
	),
});
export type CloneRequest = Static<typeof CloneRequestSchema>;

export const ToolRequestSchema = Type.Object({
	slug: Type.String({ minLength: 1, description: "Repository slug returned by /clone" }),
	sha: Type.String({ minLength: 1, description: "Resolved commit SHA to execute against" }),
	name: Type.String({ minLength: 1, description: "Tool name (rg, fd, ls, read, git)" }),
	// Tool-specific argument validation happens later in `buildToolCommand`; at
	// the HTTP boundary we only assert that `args` is an object-shaped record.
	args: Type.Record(Type.String(), Type.Unknown(), {
		description: "Tool-specific arguments; validated against per-tool schemas downstream",
	}),
});
export type ToolRequest = Static<typeof ToolRequestSchema>;

// =============================================================================
// Validation
// =============================================================================

// Compile once at module load. TypeCompiler is ~100x faster than `Value.Check`
// and these validators run on every request.
const cloneValidator = TypeCompiler.Compile(CloneRequestSchema);
const toolValidator = TypeCompiler.Compile(ToolRequestSchema);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Format the first TypeBox error as an actionable, human-readable message. */
function formatValidationError(first: { path: string; message: string } | undefined): string {
	if (!first) return "invalid request body";
	// Path looks like "/url" or "/args"; strip the leading slash for readability.
	const field = first.path.replace(/^\//, "") || "(root)";
	return `${first.message} at '${field}'`;
}

export function validateCloneRequest(raw: unknown): ValidationResult<CloneRequest> {
	if (cloneValidator.Check(raw)) {
		// `Check` is a type guard at the value level, so the cast is unnecessary —
		// TypeScript narrows `raw` for us here.
		return { ok: true, value: raw };
	}
	const [first] = [...cloneValidator.Errors(raw)];
	return { ok: false, error: formatValidationError(first) };
}

export function validateToolRequest(raw: unknown): ValidationResult<ToolRequest> {
	if (toolValidator.Check(raw)) {
		return { ok: true, value: raw };
	}
	const [first] = [...toolValidator.Errors(raw)];
	return { ok: false, error: formatValidationError(first) };
}
