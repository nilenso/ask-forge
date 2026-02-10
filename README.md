# Ask Forge

[![CI](https://github.com/nilenso/ask-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/nilenso/ask-forge/actions/workflows/ci.yml)
[![JSR](https://jsr.io/badges/@nilenso/ask-forge)](https://jsr.io/@nilenso/ask-forge)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-runtime-f9f1e1?logo=bun&logoColor=black)](https://bun.sh/)

Ask Forge allows you to programmatically ask questions to a GitHub/GitLab repository.

## Requirements

- [Bun](https://bun.sh/) (or Node.js ≥ 18)
- `git`
- `ripgrep`
- `fd`
- An LLM API key (set via environment variable, e.g. `OPENROUTER_API_KEY`)

## Installation

```bash
# Using JSR (recommended)
bunx jsr add @nilenso/ask-forge

# Or with npx
npx jsr add @nilenso/ask-forge
```

For Docker or manual setup, add to `package.json`:
```json
"@nilenso/ask-forge": "npm:@jsr/nilenso__ask-forge@0.0.5"
```

And create `.npmrc`:
```
@jsr:registry=https://npm.jsr.io
```

## Usage

```typescript
import { connect, type ForgeConfig } from "@nilenso/ask-forge";

// Configure the library
const config: ForgeConfig = {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.5",
  systemPrompt: "You are a code analysis assistant.",
  maxIterations: 20,
};

// Connect to a public repository
const session = await connect("https://github.com/owner/repo", config);

// Ask a question
const result = await session.ask("What frameworks does this project use?");
console.log(result.response);

// Clean up when done
session.close();
```

### Configuration

The `ForgeConfig` object is required and controls the AI model and behavior:

```typescript
import { connect, type ForgeConfig } from "@nilenso/ask-forge";

const config: ForgeConfig = {
  // Required: Model provider (openrouter, anthropic, google, etc.)
  provider: "openrouter",
  
  // Required: Model identifier
  model: "anthropic/claude-sonnet-4.5",
  
  // Required: System prompt that defines assistant behavior
  systemPrompt: `You are a code analysis assistant.
Use the available tools to explore the codebase and answer questions.
Be concise and ground your answers in evidence from the code.`,
  
  // Required: Maximum tool-use iterations before stopping
  maxIterations: 20,
  
  // Optional: Sandbox configuration (see Sandboxed Execution below)
  sandbox: {
    baseUrl: "http://sandbox:8080",
    timeoutMs: 120_000,
    secret: "optional-auth-secret",
  },
};
```

### Connect Options

The third parameter controls git-related options:

```typescript
import { connect, type ForgeConfig, type ConnectOptions } from "@nilenso/ask-forge";

const config: ForgeConfig = { /* ... */ };

// Connect to a specific commit, branch, or tag
const session = await connect("https://github.com/owner/repo", config, {
  commitish: "v1.0.0",
});

// Connect to a private repository with a token
const session = await connect("https://github.com/owner/repo", config, {
  token: process.env.GITHUB_TOKEN,
});

// Explicitly specify the forge (auto-detected for github.com and gitlab.com)
const session = await connect("https://gitlab.example.com/owner/repo", config, {
  forge: "gitlab",
  token: process.env.GITLAB_TOKEN,
});
```

### Custom Logger

The fourth parameter controls logging:

```typescript
import { connect, consoleLogger, nullLogger, type Logger, type ForgeConfig } from "@nilenso/ask-forge";

const config: ForgeConfig = { /* ... */ };

// Use console logger (default)
const session = await connect(url, config, {}, consoleLogger);

// Silence all logging
const session = await connect(url, config, {}, nullLogger);

// Custom logger
const customLogger: Logger = {
  log: (label, content) => myLogSystem.info(`${label}: ${content}`),
  error: (label, error) => myLogSystem.error(label, error),
};
const session = await connect(url, config, {}, customLogger);
```

### Ask Result

```typescript
import { connect, type ForgeConfig, type AskResult } from "@nilenso/ask-forge";

const config: ForgeConfig = { /* ... */ };
const session = await connect("https://github.com/owner/repo", config);
const result: AskResult = await session.ask("Explain the auth flow");

console.log(result.prompt);          // Original question
console.log(result.response);        // Final response text
console.log(result.toolCalls);       // List of tools used: { name, arguments }[]
console.log(result.inferenceTimeMs); // Total inference time in ms
console.log(result.usage);           // Token usage: { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }
```

### Streaming Progress

Use the `onProgress` callback to receive real-time events during inference:

```typescript
import { connect, type ForgeConfig, type ProgressEvent, type OnProgress } from "@nilenso/ask-forge";

const config: ForgeConfig = { /* ... */ };
const session = await connect("https://github.com/owner/repo", config);

const onProgress: OnProgress = (event: ProgressEvent) => {
  switch (event.type) {
    case "thinking":
      console.log("Model is thinking...");
      break;
    case "thinking_delta":
      process.stdout.write(event.delta); // Streaming reasoning
      break;
    case "text_delta":
      process.stdout.write(event.delta); // Streaming response text
      break;
    case "tool_start":
      console.log(`Calling tool: ${event.name}`);
      break;
    case "tool_end":
      console.log(`Tool ${event.name} completed`);
      break;
    case "responding":
      console.log("Final response ready");
      break;
  }
};

const result = await session.ask("How does authentication work?", { onProgress });
```

### Session Management

Sessions maintain conversation history for multi-turn interactions:

```typescript
import { connect, type ForgeConfig, type Session, type Message } from "@nilenso/ask-forge";

const config: ForgeConfig = { /* ... */ };
const session: Session = await connect("https://github.com/owner/repo", config);

// Session properties
console.log(session.id);              // Unique session identifier
console.log(session.repo.url);        // Repository URL
console.log(session.repo.localPath);  // Local worktree path
console.log(session.repo.commitish);  // Resolved commit SHA

// Multi-turn conversation
await session.ask("What is this project?");
await session.ask("Tell me more about the auth module"); // Has context from first question

// Access conversation history
const messages: Message[] = session.getMessages();

// Restore a previous conversation
session.replaceMessages(savedMessages);

// Clean up (removes git worktree)
session.close();
```


## Sandboxed Execution

For production deployments, Ask Forge can run tool execution in an isolated container. Enable sandbox mode by adding the `sandbox` field to your config:

```typescript
import { connect, type ForgeConfig } from "@nilenso/ask-forge";

const config: ForgeConfig = {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.5",
  systemPrompt: "You are a code analysis assistant.",
  maxIterations: 20,
  
  // Enable sandboxed execution
  sandbox: {
    baseUrl: "http://sandbox:8080",  // Sandbox worker URL
    timeoutMs: 120_000,              // Request timeout
    secret: "optional-auth-secret",  // Optional auth token
  },
};

// All operations (clone + tool execution) now run in the sandbox
const session = await connect("https://github.com/owner/repo", config);
```

### Security Layers

| Layer | Mechanism | Protection |
|-------|-----------|------------|
| 1 | bwrap (bubblewrap) | Filesystem and PID namespace isolation |
| 2 | seccomp BPF | Blocks network socket creation for tools |
| 3 | gVisor (optional) | Kernel-level syscall sandboxing |
| 4 | Path validation | Prevents directory traversal attacks |

### Architecture

```
sandbox/
├── client.ts          # HTTP client for the sandbox worker
├── worker.ts          # HTTP server (runs in container)
├── Containerfile
└── isolation/         # Security primitives
    ├── index.ts       # bwrap + seccomp wrappers
    └── seccomp/       # BPF filter sources (C)
```

### Running the Sandbox

**Prerequisite:** [Install gVisor](https://gvisor.dev/docs/user_guide/install/) and register it with Docker/Podman.

```bash
# Using just (recommended)
just sandbox-up        # Start container
just sandbox-down      # Stop container
just sandbox-logs      # View logs

# Or with docker-compose
docker-compose up -d
```

### HTTP API

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Liveness check |
| `/clone` | POST | `{ url, commitish? }` | Clone repo and checkout commit |
| `/tool` | POST | `{ slug, sha, name, args }` | Execute tool (rg, fd, ls, read, git) |
| `/reset` | POST | — | Delete all cloned repos |

### Testing the Sandbox

```bash
just isolation-tests     # Test bwrap + seccomp (runs on host)
just sandbox-tests       # Test HTTP API + security (runs against container)
just sandbox-all-tests   # Run both
```

The test suite includes 49 tests covering:
- Filesystem isolation and read-only enforcement
- PID namespace isolation
- Network blocking via seccomp
- Path traversal prevention
- Command injection protection
- Input validation

## Development

### Running from source

```bash
bun install
bun run ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```

The CLI uses settings from `config.ts` (model, system prompt, etc.).

### Testing

```bash
just test               # Run all unit tests
just isolation-tests    # Test security isolation (bwrap + seccomp)
just sandbox-tests      # Test sandbox HTTP API
just sandbox-all-tests  # Run all sandbox tests
```

### Evaluation

The `eval/` folder contains an evaluation system for testing code analysis agents.

```bash
source .venv/bin/activate
cd eval
python test-dataset.py 5 ask-forge
python review-server.py  # Open http://localhost:5001
```
