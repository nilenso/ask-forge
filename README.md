# Ask Forge

Typescript library that can be used to safely query a remote git repository.

Ask forge clones that repository and runs an LLM agent with access to that repository that consumers can query.

## Usage

```bash
bun install
bun run test-ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```

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
