/**
 * Configuration for ask-forge agent.
 *
 * This file contains all configurable settings for the TypeScript agent.
 */

// =============================================================================
// GIT CONFIGURATION
// =============================================================================

/**
 * Git environment variables to prevent interactive prompts and SSH key loading.
 * Used when spawning git processes.
 */
export const GIT_ENV: Record<string, string> = {
	// Disable SSH agent and key loading
	SSH_AUTH_SOCK: "",
	// Use a non-existent SSH key to prevent loading default keys
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	// Disable terminal prompts for credentials
	GIT_TERMINAL_PROMPT: "0",
	// Disable askpass programs
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	// Preserve PATH for git to work
	PATH: process.env.PATH || "",
};

// =============================================================================
// MODEL CONFIGURATION
// =============================================================================

/** Model provider (e.g., "openrouter", "anthropic") */
export const MODEL_PROVIDER = "openrouter";

/** Model identifier */
export const MODEL_NAME = "anthropic/claude-sonnet-4.5";

/** Maximum tool-use iterations (how many tool calls the agent can make before giving a final answer) */
export const MAX_TOOL_ITERATIONS = 20;

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
