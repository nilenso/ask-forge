/**
 * Configuration for ask-forge agent.
 *
 * This file contains all configurable settings for the TypeScript agent.
 */

// =============================================================================
// THINKING CONFIGURATION
// =============================================================================

/** Whether thinking is off or adaptive (model decides when/how much to think) */
export type ThinkingMode = "off" | "adaptive";

/**
 * Configuration for Claude's adaptive/extended thinking.
 * Default: thinking is off. Enable via `mode: "adaptive"` for eval-gated rollout.
 */
export interface ThinkingConfig {
	/** Thinking mode: "off" (default) or "adaptive" */
	mode: ThinkingMode;
	/** Effort level for adaptive thinking (Anthropic Opus 4.6+ only). Default: "high" */
	effort?: "low" | "medium" | "high" | "max";
	/** Explicit token budget for extended thinking (older Anthropic models). Ignored for adaptive. */
	budgetTokens?: number;
}

// =============================================================================
// MODEL CONFIGURATION
// =============================================================================

/** Model provider (e.g., "openrouter", "anthropic") */
export const MODEL_PROVIDER = "openrouter" as const;

/** Model identifier */
export const MODEL_NAME = "anthropic/claude-sonnet-4.6" as const;

/** Maximum tool-use iterations (how many tool calls the agent can make before giving a final answer) */
export const MAX_TOOL_ITERATIONS = 20;

// =============================================================================
// CONTEXT COMPACTION CONFIGURATION
// =============================================================================

/**
 * Default settings for context compaction.
 * When context grows too large, older messages are summarized to stay within limits.
 */
export const COMPACTION_SETTINGS = {
	/** Whether compaction is enabled */
	enabled: true,
	/** Tokens to reserve for LLM response */
	reserveTokens: 16384,
	/** Recent tokens to keep (not summarized) */
	keepRecentTokens: 20000,
	/** Model context window size */
	contextWindow: 200000,
};

export type CompactionSettings = typeof COMPACTION_SETTINGS;

// =============================================================================
// SYSTEM PROMPT
// =============================================================================

// The default system prompt is now built dynamically in src/index.ts via
// buildDefaultSystemPrompt(repoUrl, commitSha) so it can embed permalink URLs.
// See src/index.ts for the canonical prompt text.
