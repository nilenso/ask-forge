"""
Configuration for LLM Judge settings.

Note: ask-forge agent config is in config.ts (TypeScript)
"""

# =============================================================================
# LLM JUDGE CONFIGURATION
# =============================================================================

# Model to use for fact verification (via OpenRouter)
# Examples: "openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-3-haiku"
LLM_JUDGE_MODEL = "openai/gpt-5"

# Maximum tokens for judge response
LLM_JUDGE_MAX_TOKENS = 10

# Prompt template for fact verification
# Available placeholders: {fact}, {response}
LLM_JUDGE_PROMPT = """You are a fact verification judge. Your task is to determine if a given fact is represented or supported by the response text.

FACT TO VERIFY:
{fact}

RESPONSE TEXT:
{response}

Instructions:
- Determine if the response contains information that supports or represents the fact
- The fact doesn't need to be stated verbatim, but the core information should be present
- Be strict: partial matches or vague similarities are not sufficient
- Consider semantic equivalence, not just keyword matching

Answer with ONLY "true" or "false" (lowercase, no explanation)."""


# =============================================================================
# AVAILABLE AGENTS
# =============================================================================

# List of available agents for the UI
AVAILABLE_AGENTS = [
    "ask-forge",
]
