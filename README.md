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
import { connect } from "@nilenso/ask-forge";

// Connect to a public repository
const session = await connect("https://github.com/owner/repo");

// Ask a question
const result = await session.ask("What frameworks does this project use?");
console.log(result.response);

// Clean up when done
session.close();
```

### Connect Options

```typescript
import { connect, type ConnectOptions } from "@nilenso/ask-forge";

// Connect to a specific commit, branch, or tag
const session = await connect("https://github.com/owner/repo", {
  commitish: "v1.0.0",
});

// Connect to a private repository with a token
const session = await connect("https://github.com/owner/repo", {
  token: process.env.GITHUB_TOKEN,
});

// Explicitly specify the forge (auto-detected for github.com and gitlab.com)
const session = await connect("https://gitlab.example.com/owner/repo", {
  forge: "gitlab",
  token: process.env.GITLAB_TOKEN,
});
```

### Custom Logger

```typescript
import { connect, consoleLogger, nullLogger, type Logger } from "@nilenso/ask-forge";

// Use console logger (default)
const session = await connect(url, {}, consoleLogger);

// Silence all logging
const session = await connect(url, {}, nullLogger);

// Custom logger
const customLogger: Logger = {
  log: (label, content) => myLogSystem.info(`${label}: ${content}`),
  error: (label, error) => myLogSystem.error(label, error),
};
const session = await connect(url, {}, customLogger);
```

### Ask Result

```typescript
import { connect, type AskResult } from "@nilenso/ask-forge";

const session = await connect("https://github.com/owner/repo");
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
import { connect, type AskOptions, type ProgressEvent, type OnProgress } from "@nilenso/ask-forge";

const session = await connect("https://github.com/owner/repo");

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
import { connect, type Session, type Message } from "@nilenso/ask-forge";

const session: Session = await connect("https://github.com/owner/repo");

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

For production deployments, Ask Forge can run tool execution in an isolated container with defense-in-depth security:

- **Layer 1 — bwrap (bubblewrap)**: Per-operation filesystem and PID namespace isolation. Tool calls are scoped to their worktree with no visibility of other processes.
- **Layer 2 — seccomp**: BPF filter blocks network socket creation (`AF_INET`/`AF_INET6`) for tool execution. Tools cannot make any network connections.
- **Layer 3 — gVisor (runsc)**: Kernel-level syscall sandboxing for the container runtime (when enabled via `--runtime=runsc`).
- **Layer 4 — Path validation**: Worker code validates all paths to prevent traversal attacks.

> **Note**: Git operations require network access for cloning. Tool execution (rg, fd, ls, read) has network access blocked via seccomp BPF filter.

### Running with Docker/Podman

```bash
# Start the sandbox worker (development - no gVisor)
docker-compose up -d
```

**For production**, enable gVisor for kernel-level syscall sandboxing:

1. [Install gVisor](https://gvisor.dev/docs/user_guide/install/) on the host
2. Uncomment `runtime: runsc` in `docker-compose.yml`
3. Run `docker-compose up -d`

The sandbox worker exposes an HTTP API on port 8080. Configure your application with:

```bash
export SANDBOX_URL="http://localhost:8080"
export SANDBOX_SECRET="your-shared-secret"  # Optional authentication
```

### Sandbox HTTP API

The sandbox worker exposes these endpoints:

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Liveness check |
| `/clone` | POST | `{ url, commitish? }` | Clone a repo and checkout a commit |
| `/tool` | POST | `{ slug, sha, name, args }` | Execute a tool (rg, fd, ls, read) |
| `/reset` | POST | — | Delete all cloned repos |

Example:

```bash
# Clone a repository
curl -X POST http://localhost:8080/clone \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SANDBOX_SECRET" \
  -d '{"url": "https://github.com/owner/repo", "commitish": "main"}'

# Execute ripgrep
curl -X POST http://localhost:8080/tool \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SANDBOX_SECRET" \
  -d '{"slug": "github.com_owner_repo", "sha": "abc123...", "name": "rg", "args": {"pattern": "TODO"}}'
```

## Development

### Running from source

```bash
bun install
bun run ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```

### Evaluation

The `eval/` folder contains an evaluation system for testing code analysis agents.

```bash
# Activate the virtual environment
source .venv/bin/activate

# Run tests
cd eval
python test-dataset.py 5 ask-forge

# Start review server
python review-server.py
# Open http://localhost:5001
```

### Configuration

- `config.ts` — Agent model and prompt settings (TypeScript)
- `eval/config.py` — LLM judge and Claude agent settings (Python)

### Repo Isolation

For repo isolation, we `git fetch` (if needed) and add a new worktree with the committish provided. This approach:
- Ensures each query operates on an isolated copy of the repository at the specified revision
- Avoids conflicts with the main working directory
- Allows concurrent queries on different commits/branches without interference
- Since ask-forge is exposed as a library, different service users may request the same repo@commit. We skip fetching if the committish is already available locally, avoiding redundant network calls.
