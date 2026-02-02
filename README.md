# Ask Forge

[![CI](https://github.com/nilenso/ask-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/nilenso/ask-forge/actions/workflows/ci.yml)
[![JSR](https://jsr.io/badges/@nilenso/ask-forge)](https://jsr.io/@nilenso/ask-forge)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-runtime-f9f1e1?logo=bun&logoColor=black)](https://bun.sh/)

Ask Forge allows you to programmatically ask questions to a github/gitlab repository.

## Requirements

- [Bun](https://bun.sh/) (or Node.js ≥ 18)
- `git`
- `ripgrep` (`rg`)
- An LLM API key (set via environment variable, e.g. `OPENROUTER_API_KEY`)

## Installation

```bash
# npm
npm install ask-forge

# bun
bun add ask-forge
```

## Usage

```typescript
import { connect } from "ask-forge";

// Connect to a public repository
const session = await connect("https://github.com/owner/repo");

// Ask a question
const result = await session.ask("What frameworks does this project use?");
console.log(result.response);

// Clean up when done
session.close();
```

### Options

```typescript
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

### Streaming progress

```typescript
const result = await session.ask("Explain the auth flow", {
  onProgress(event) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.delta);
        break;
      case "tool_start":
        console.log(`Using tool: ${event.name}`);
        break;
    }
  },
});
```

### Running from source

```bash
bun install
bun run ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```

## Development

### Web UI

Run the web interface to ask questions and collect feedback:

```bash
bun run web
# Open http://localhost:3000
```

Features:
- Ask questions about any git repo (GitHub, GitLab, etc.)
- View agent responses and tool calls
- Provide binary feedback (correct/incorrect)
- Tag difficulty (easy/medium/hard)
- Samples saved to `web/data/samples.json`

### Evaluation

The `eval/` folder contains a human-in-the-loop evaluation system for testing code analysis agents.

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

Since ask-forge is exposed as a library, different service users may request the same repo@commit. We skip fetching if the committish is already available locally, avoiding redundant network calls.
