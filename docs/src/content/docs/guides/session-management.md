---
title: Session Management
description: Session lifecycle, state accessors, restoration, and conversation branching.
sidebar:
  order: 4
---

A `Session` manages a multi-turn conversation with an AI model about a code repository. It holds the conversation context, tracks completed turns, and cleans up resources on close.

### Lifecycle

```ts
import { Client } from "@nilenso/megasthenes";

const client = new Client();

// 1. Connect — clones the repo and creates a session
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});

// 2. Ask — each call continues the conversation with full context
await session.ask("What does this repo do?").result();
await session.ask("How are the tests structured?").result();

// 3. Close — cleans up the git worktree
await session.close();
```

### Session Properties

| Property | Type | Description |
|---|---|---|
| `id` | `string` | Unique session identifier (UUID). |
| `repo` | `Repo` | The connected repository (URL, local path, commit SHA). |
| `config` | `PublicSessionConfig` | Immutable snapshot of the session configuration. |

### Accessors

```ts
// Get all completed turns in chronological order
const turns = session.getTurns();

// Get a specific turn by ID
const turn = session.getTurn("some-turn-id");

// Get the current compaction summary (if compaction has occurred)
const summary = session.getCompactionSummary();
```

### Session Restoration

You can save and restore a session's state to continue a conversation across process restarts or different sessions:

```ts
// Save session state
const turns = session.getTurns();
const compactionSummary = session.getCompactionSummary();
await session.close();

// ... persist turns and compactionSummary ...

// Restore in a new session
const newSession = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  compaction: { enabled: true, contextWindow: 200_000 },
  initialTurns: turns,
  lastCompactionSummary: compactionSummary,
});

// The conversation continues with full context
await newSession.ask("Based on our earlier discussion, what else should I know?").result();
```

The `initialTurns` field seeds the session with prior turn results, and `lastCompactionSummary` provides the compaction state so that context compression can continue seamlessly.

### Conversation Branching

Use the `afterTurn` option to branch the conversation from a specific turn, creating a "what if" fork:

```ts
const turn1 = await session.ask("What testing frameworks does this project use?").result();
const turn2 = await session.ask("How is the CI pipeline configured?").result();

// Branch back to after turn 1, ignoring turn 2
const stream = session.ask("What about integration tests specifically?", {
  afterTurn: turn1.id,
});
```

This restores the conversation context to the state it was in right after the specified turn, then appends the new question. The original conversation history is preserved — branching creates a new path, it doesn't rewrite history.

### Cleanup

`session.close()` removes the git worktree created for this session. It is safe to call multiple times and returns a `Promise<void>`.

```ts
await session.close();
```
