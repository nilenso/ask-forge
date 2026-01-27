/**
 * Configuration for ask-forge agent.
 *
 * This file contains all configurable settings for the TypeScript agent.
 */

// =============================================================================
// MODEL CONFIGURATION
// =============================================================================

/** Model provider (e.g., "openrouter", "anthropic") */
export const MODEL_PROVIDER = "openrouter";

/** Model identifier */
export const MODEL_NAME = "anthropic/claude-opus-4";

/** Maximum tool-use iterations (how many tool calls the agent can make before giving a final answer) */
export const MAX_TOOL_ITERATIONS = 10;

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

Response guidelines:
- Be concise and to the point. No preamble or filler.
- Use structured format: headings, bullet points, or numbered lists.
- Cite file paths when relevant (e.g., "src/auth.ts:42").
- Avoid lengthy prose. Prefer short statements.`;
