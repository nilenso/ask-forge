# Ask Forge

Typescript library that can be used to safely query a remote git repository.

Ask forge clones that repository and runs an LLM agent with access to that repository that consumers can query.

## Usage

```bash
bun install
bun run test-ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```

## Web UI

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

## Evaluation

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

- `config.ts` - Agent model and prompt settings (TypeScript)
- `eval/config.py` - LLM judge and Claude agent settings (Python)



## Implementation Decisions

### Repo Isolation

For repo isolation, we will `git fetch` (if needed) and add a new worktree with the committish provided. This approach:
- Ensures each query operates on an isolated copy of the repository at the specified revision
- Avoids conflicts with the main working directory
- Allows concurrent queries on different commits/branches without interference

Since ask-forge is exposed as a library, different service users may request the same repo@commit. We skip fetching if the committish is already available locally, avoiding redundant network calls.

## TODOs

- [x] Test with a specific forge revision (commit/branch/tags)
- [x] Test if model is able to access other repos in workdir
  - [x] Explore sandboxing to prevent access to other repos in workdir
- [ ] Revisit tools that we use
- [ ] Revisit and optimise parallel git clone (currently using a simple lock to prevent race conditions)
- [ ] Revisit eval metrics (precision, recall, accuracy definitions)
- [x] Build a web UI for ask-forge where users can:
  - Ask questions about any git repo (GitHub, GitLab, etc.) with repo URL and optional committish
  - View the agent's response
  - Provide binary feedback (correct/incorrect)
  - Tag answers with difficulty (easy/medium/hard)
  - This will be used to create a new dataset for evaluating ask-forge
  - Each sample: question, answer, repo URL, committish, difficulty tag, binary feedback
  - [ ] A user should be able login using github or gmail. 
- [ ] A user should be able to the last 10 server session history. Sessions will be stored in server.
- [ ] A user should be able to switch sessions.
- [ ] A user should be able to continue from where it left off when they switch to a previous session.
