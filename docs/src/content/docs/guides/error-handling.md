---
title: Error Handling
description: Handle structured errors from stream events and thrown exceptions.
sidebar:
  order: 7
---

megasthenes surfaces errors in two ways:

1. **Stream events** — an `error` event in the `AskStream` for errors during a turn (e.g., hitting max iterations, context overflow).
2. **Thrown exceptions** — a `MegasthenesError` thrown from `connect()` or other operations for unrecoverable failures (e.g., invalid config, clone failure).

Both carry a typed `errorType` field for programmatic handling.

### ErrorType

All errors include one of these types:

| ErrorType | Description | Retryable |
|---|---|---|
| `aborted` | User cancelled via `AbortSignal` | No |
| `max_iterations` | Reached the `maxIterations` limit | No |
| `context_overflow` | Model context window exceeded | Yes |
| `provider_error` | LLM API error (rate limit, server error, etc.) | Varies |
| `empty_response` | Model returned no content | Yes |
| `network_error` | Network-level failure | Yes |
| `internal_error` | Bug in megasthenes | No |
| `clone_failed` | Git clone failed | Yes |
| `invalid_commitish` | Branch, tag, or SHA doesn't exist | No |
| `invalid_config` | Configuration validation error | No |

### Handling Stream Errors

Errors during a turn appear as `error` events in the stream and are also reflected in the `TurnResult`:

```ts
const stream = session.ask("Analyze this codebase");

for await (const event of stream) {
  if (event.type === "error") {
    switch (event.errorType) {
      case "max_iterations":
        console.log("Hit iteration limit — partial answer available");
        break;
      case "context_overflow":
        console.log("Context too large — consider enabling compaction");
        break;
      default:
        console.error(`Error: [${event.errorType}] ${event.message}`);
    }
  }
}

// The TurnResult also carries the error
const result = await stream.result();
if (result.error) {
  console.log(`Turn ended with: ${result.error.errorType}`);
  console.log(`Retryable: ${result.error.isRetryable}`);
}
```

### Handling Thrown Errors

Operations like `connect()` throw `MegasthenesError` for failures that prevent a turn from starting:

```ts
import { Client, MegasthenesError } from "@nilenso/megasthenes";

const client = new Client();

try {
  const session = await client.connect({
    repo: { url: "https://github.com/owner/repo", commitish: "nonexistent" },
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    maxIterations: 20,
  });
} catch (err) {
  if (err instanceof MegasthenesError) {
    console.error(`[${err.errorType}] ${err.message}`);
    if (err.isRetryable) {
      // Safe to retry
    }
  }
}
```

### Retryability

The `isRetryable` field indicates whether retrying the same operation might succeed:

| Value | Meaning |
|---|---|
| `true` | Transient failure — safe to retry (e.g., network error, rate limit). |
| `false` | Permanent failure — retrying won't help (e.g., invalid config, nonexistent commit). |
| `null` | Unknown — the error is opaque (e.g., generic provider error). |

### MegasthenesError

```ts
class MegasthenesError extends Error {
  readonly errorType: ErrorType;
  readonly isRetryable: boolean | null;
  readonly details?: unknown;
}
```

The `details` field may contain the raw error from the provider or other debugging context. The standard `cause` property is also set when the error wraps an underlying exception.
