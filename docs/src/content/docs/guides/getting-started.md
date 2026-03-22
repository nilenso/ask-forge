---
title: Getting Started
description: Install and use ask-forge to connect an LLM to a git repository.
---

## Installation

```bash
# npm (via JSR)
npx jsr add @nilenso/ask-forge

# Bun
bunx jsr add @nilenso/ask-forge
```

## Quick Start

```ts
import { AskForgeClient } from "@nilenso/ask-forge";

const client = new AskForgeClient({
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4-20250514",
});

const session = await client.connect("https://github.com/owner/repo");

const result = await session.ask("What does this repo do?");
console.log(result.response);
```

## Configuration

The `AskForgeClient` accepts a configuration object:

```ts
const client = new AskForgeClient({
  // Required: model provider and model name (or omit both for defaults)
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4-20250514",

  // Optional: custom system prompt
  systemPrompt: "You are a code analysis assistant.",

  // Optional: max tool-use iterations (default: 20)
  maxIterations: 20,

  // Optional: sandbox configuration for isolated execution
  sandbox: {
    baseUrl: "http://localhost:8080",
  },

  // Optional: context compaction settings
  compaction: {
    enabled: true,
    contextWindow: 200_000,
  },
});
```

## Connecting to a Repository

```ts
const session = await client.connect("https://github.com/owner/repo", {
  // Optional: specific commit or branch
  commitish: "main",
  // Optional: authentication token
  token: process.env.GITHUB_TOKEN,
});
```

## Asking Questions

Each call to `session.ask()` continues the conversation with full context:

```ts
const result = await session.ask("What testing framework does this project use?");

console.log(result.response);       // The LLM's answer
console.log(result.toolCalls);      // Tools invoked (rg, fd, read, etc.)
console.log(result.invalidLinks);   // Any invalid links detected
```

## Progress Callbacks

Track what the LLM is doing in real-time:

```ts
const result = await session.ask("Find all API endpoints", {
  onProgress: (event) => {
    switch (event.type) {
      case "tool_call":
        console.log(`Using tool: ${event.name}`);
        break;
      case "text_delta":
        process.stdout.write(event.text);
        break;
    }
  },
});
```
