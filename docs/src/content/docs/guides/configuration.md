---
title: Configuration
description: Configure the model provider, system prompt, sandbox, and other settings.
sidebar:
  order: 2
---

megasthenes uses a two-tier configuration model:

- **`ClientConfig`** — shared infrastructure (sandbox, logging). Passed to the `Client` constructor.
- **`SessionConfig`** — behavioral settings (model, repo, thinking, compaction). Passed to `client.connect()`.

This separation lets you create one client and connect to multiple repositories with different models and settings.

### Client Configuration

The `Client` constructor accepts optional infrastructure config:

```ts
import { Client, consoleLogger, nullLogger } from "@nilenso/megasthenes";

// Defaults: no sandbox, console logging
const client = new Client();

// With custom logging
const client = new Client({ logger: nullLogger });

// With sandbox mode
const client = new Client({
  sandbox: {
    baseUrl: "http://localhost:8080",
    timeoutMs: 120_000,
    secret: "optional-auth-secret",
  },
});
```

See the [Sandboxed Execution guide](/megasthenes/guides/sandbox/) for details on running the sandbox server.

### Logging

```ts
import {
  Client,
  consoleLogger,
  nullLogger,
  type Logger,
} from "@nilenso/megasthenes";

// Console logger (default)
const client = new Client({ logger: consoleLogger });

// Silence all logging
const client = new Client({ logger: nullLogger });

// Custom logger
const customLogger: Logger = {
  error: (label, error) => myLogSystem.error(label, error),
  warn: (label, content) => myLogSystem.warn(`${label}: ${content}`),
  log: (label, content) => myLogSystem.info(`${label}: ${content}`),
  info: (label, content) => myLogSystem.info(`${label}: ${content}`),
  debug: (label, content) => myLogSystem.debug(`${label}: ${content}`),
};
const client = new Client({ logger: customLogger });
```

### Session Configuration

All behavioral config is passed to `client.connect()`:

```ts
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});
```

### Repository Options

```ts
// Connect to a specific commit, branch, or tag
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo", commitish: "v1.0.0" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});

// Private repository with a token
const session = await client.connect({
  repo: {
    url: "https://github.com/owner/repo",
    token: process.env.GITHUB_TOKEN,
  },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});

// Self-hosted GitLab (forge auto-detected for github.com and gitlab.com)
const session = await client.connect({
  repo: {
    url: "https://gitlab.example.com/owner/repo",
    forge: "gitlab",
    token: process.env.GITLAB_TOKEN,
  },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});
```

### Model and Provider

The `model` field in `SessionConfig` requires both a `provider` and an `id`. Available providers and model IDs are defined in [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/blob/main/packages/pi-ai/src/models.generated.ts). The corresponding API key environment variable is resolved automatically (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`).

```ts
// OpenRouter
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "openrouter", id: "anthropic/claude-sonnet-4-6" },
  maxIterations: 20,
});

// Anthropic direct
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});

// Google
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "google", id: "gemini-2.5-pro" },
  maxIterations: 20,
});
```

### System Prompt

By default, megasthenes builds a system prompt that includes the repository URL and commit SHA. You can override it to customize the assistant's behavior:

```ts
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  systemPrompt: "You are a security auditor. Focus on identifying vulnerabilities.",
});
```

You can also build the default prompt yourself and extend it:

```ts
import { Client, buildDefaultSystemPrompt } from "@nilenso/megasthenes";

const base = buildDefaultSystemPrompt("https://github.com/owner/repo", "abc123");
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  systemPrompt: `${base}\n\nAlways respond in Spanish.`,
});
```

### Thinking

Control the model's reasoning/thinking behavior via the `thinking` field. Megasthenes supports two modes:

- **Effort-based** (cross-provider): Set an effort level that pi-ai maps to each provider's native format (`reasoning.effort` for OpenAI, `thinking` for Anthropic, etc.)
- **Adaptive** (Anthropic 4.6 only): The model decides when and how much to think per request

```ts
// OpenAI — effort-based reasoning
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "openai", id: "o3" },
  maxIterations: 20,
  thinking: { effort: "low" },
});

// Anthropic 4.5 — effort-based
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-5-20251022" },
  maxIterations: 20,
  thinking: { effort: "high", budgetOverrides: { high: 10000 } },
});

// Anthropic 4.6 — adaptive (model decides when/how much to think)
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  thinking: { type: "adaptive" },
});

// Anthropic 4.6 — adaptive with explicit effort guidance
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  thinking: { type: "adaptive", effort: "medium" },
});

// No thinking (default — omit the thinking field)
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"adaptive"` | Anthropic 4.6 only. Omit for effort-based mode. |
| `effort` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | Required for effort-based, optional for adaptive. |
| `budgetOverrides` | `ThinkingBudgets` | Custom token budgets per level (effort-based only). |

### Context Compaction

When conversations grow long, megasthenes can automatically summarize older messages to stay within the model's context window. This is enabled by default.

```ts
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  compaction: {
    enabled: true,            // default: true
    contextWindow: 200_000,   // default: 200K tokens
    reserveTokens: 16_384,    // default: 16K — tokens reserved for the response
    keepRecentTokens: 20_000, // default: 20K — recent messages to keep unsummarized
  },
});
```

### Tracing

megasthenes emits [OpenTelemetry](https://opentelemetry.io/) spans following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/). The library depends only on `@opentelemetry/api` — if no OTel SDK is installed, all tracing is a zero-overhead no-op.

To send traces to any OTel-compatible backend (Jaeger, Honeycomb, Langfuse, etc.):

1. Install `@opentelemetry/sdk-node` and your backend's exporter or span processor
2. Create and start a `NodeSDK` instance **before** creating any `Client`
3. All `session.ask()` calls will automatically emit spans to your backend

#### Console (development)

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";

const sdk = new NodeSDK({ traceExporter: new ConsoleSpanExporter() });
sdk.start();
```

#### Langfuse

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});
sdk.start();
```

See the [Observability guide](/megasthenes/guides/observability/) for the full trace structure and captured attributes.

### Streaming

`session.ask()` returns an `AskStream` — an async iterable of `StreamEvent` objects. Consume events in real time or await the final result:

```ts
const stream = session.ask("Find all API endpoints");

for await (const event of stream) {
  switch (event.type) {
    case "tool_use_start":
      console.log(`Using tool: ${event.name}`);
      break;
    case "text_delta":
      process.stdout.write(event.delta);
      break;
  }
}

const result = await stream.result();
```

See the [Streaming guide](/megasthenes/guides/streaming/) for the full event type reference and advanced patterns.
