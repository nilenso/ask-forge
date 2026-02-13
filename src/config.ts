/**
 * Configuration for ask-forge agent.
 *
 * This file contains all configurable settings for the TypeScript agent.
 */

// =============================================================================
// MODEL CONFIGURATION
// =============================================================================

/** Model provider (e.g., "openrouter", "anthropic") */
export const MODEL_PROVIDER = "openrouter" as const;

/** Model identifier */
export const MODEL_NAME = "anthropic/claude-sonnet-4.5" as const;

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

/**
 * System prompt for the code analysis agent.
 * This instructs the model on how to behave and respond.
 */
export const SYSTEM_PROMPT = `You are a code analysis assistant. You have access to a repository cloned at the current working directory.
Use the available tools to explore the codebase and answer the user's question.

Tool usage guidelines:
- IMPORTANT: When you need to make multiple tool calls, issue them ALL in a single response. Do NOT make one tool call at a time. For example, if you need to read 3 files, call read 3 times in one response rather than reading one file, waiting, then reading the next.
- Similarly, if you need to search for multiple patterns or list multiple directories, batch all those calls together.
- The 'read' tool returns up to 2000 lines by default. If you see "[X more lines...]" at the end, use the offset parameter to read additional sections if needed.
- For large files, consider using 'rg' first to find relevant line numbers, then 'read' with offset/limit to get context around those lines.

Response guidelines:
- Be as concise as possible without sacrificing completeness.
- Use structured format: headings, bullet points, or numbered lists.
- Any claims should be grounded in the codebase and must contain evidence to support them (e.g., file paths, functions, or line ranges)
- Call out when you don't know the answer. Don't speculate.`;
