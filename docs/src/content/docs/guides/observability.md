---
title: Observability
description: Monitor megasthenes sessions with OpenTelemetry tracing.
sidebar:
  order: 6
---

megasthenes instruments all LLM interactions with [OpenTelemetry](https://opentelemetry.io/) spans following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

### Setup

Install the OpenTelemetry SDK and configure a tracer provider before creating sessions:

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new SimpleSpanProcessor(new OTLPTraceExporter())
);
provider.register();
```

Once registered, all `session.ask()` calls automatically emit spans.

### Trace Structure

```
megasthenes.session.ask
├── megasthenes.compaction (if context was compacted)
├── gen_ai.chat (per LLM iteration)
│   └── gen_ai.execute_tool (per tool invocation)
├── gen_ai.chat
│   └── gen_ai.execute_tool
└── ...
```

### Captured Attributes

#### Ask span (`megasthenes.session.ask`)

| Attribute | Description |
|---|---|
| `gen_ai.operation.name` | `"chat"` |
| `gen_ai.request.model` | Model identifier |
| `megasthenes.session.id` | Unique session ID |
| `megasthenes.repo.url` | Repository URL |
| `megasthenes.repo.commitish` | Resolved commit SHA |
| `gen_ai.usage.input_tokens` | Total prompt tokens |
| `gen_ai.usage.output_tokens` | Total completion tokens |
| `megasthenes.total_iterations` | Number of LLM iterations in the turn |
| `megasthenes.total_tool_calls` | Total tool invocations in the turn |

#### Generation span (`gen_ai.chat`)

| Attribute | Description |
|---|---|
| `gen_ai.operation.name` | `"chat"` |
| `gen_ai.request.model` | Model identifier |
| `gen_ai.provider.name` | Provider name |
| `megasthenes.iteration` | Zero-based iteration index |
| `gen_ai.usage.input_tokens` | Prompt tokens for this iteration |
| `gen_ai.usage.output_tokens` | Completion tokens for this iteration |
| `gen_ai.usage.cache_read.input_tokens` | Prompt cache hits |
| `gen_ai.usage.cache_creation.input_tokens` | Prompt cache writes |
| `gen_ai.response.finish_reason` | Why the model stopped |

#### Tool span (`gen_ai.execute_tool`)

| Attribute | Description |
|---|---|
| `gen_ai.operation.name` | `"execute_tool"` |
| `gen_ai.tool.name` | Tool name (`rg`, `fd`, `read`, `ls`, `git`) |
| `gen_ai.tool.call.id` | Unique tool call ID |

#### Compaction span

| Attribute | Description |
|---|---|
| `megasthenes.compaction.was_compacted` | Whether compaction occurred |
| `megasthenes.compaction.tokens_before` | Token count before compaction |
| `megasthenes.compaction.tokens_after` | Token count after compaction |

#### Error attributes

| Attribute | Description |
|---|---|
| `error.type` | Standard OTel error type |
| `megasthenes.error.name` | Error name |
| `megasthenes.error.message` | Error message |

### OTel Events

The library also emits OTel events on spans following GenAI conventions:

| Event | Description |
|---|---|
| `gen_ai.system_instructions` | System prompt content |
| `gen_ai.input.messages` | Input messages to the model |
| `gen_ai.output.messages` | Output messages from the model |
| `gen_ai.tool.call.arguments` | Tool call argument JSON |
| `gen_ai.tool.call.result` | Tool execution result |
