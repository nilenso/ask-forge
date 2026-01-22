# Ask Forge

Typescript library that can be used to safely query a remote git repository.

Ask forge clones that repository and runs an LLM agent with access to that repository that consumers can query.

## Usage

```bash
bun install
bun run test-ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```



## Implementation Decisions

### Repo Isolation

For repo isolation, we will `git fetch` (if needed) and add a new worktree with the committish provided. This approach:
- Ensures each query operates on an isolated copy of the repository at the specified revision
- Avoids conflicts with the main working directory
- Allows concurrent queries on different commits/branches without interference

Since ask-forge is exposed as a library, different service users may request the same repo@commit. We skip fetching if the committish is already available locally, avoiding redundant network calls.

## TODOs

- [ ] Test with a specific forge revision (commit/branch/tags)
- [ ] Test if model is able to access other repos in workdir
  - [ ] Explore sandboxing to prevent access to other repos in workdir
- [ ] Revisit tools that we use
