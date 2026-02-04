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
  info: (msg) => myLogSystem.info(msg),
  error: (msg) => myLogSystem.error(msg),
};
const session = await connect(url, {}, customLogger);
```

### Ask Result

```typescript
import { connect, type AskResult, type Usage } from "@nilenso/ask-forge";

const session = await connect("https://github.com/owner/repo");
const result: AskResult = await session.ask("Explain the auth flow");

console.log(result.prompt);          // Original question
console.log(result.response);        // Final response text
console.log(result.toolCalls);       // List of tools used: { name, arguments }[]
console.log(result.inferenceTimeMs); // Total inference time in ms
console.log(result.usage);           // Token usage statistics
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
