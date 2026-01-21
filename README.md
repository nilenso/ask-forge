# Ask Forge

Typescript library that can be used to safely query a remote git repository.

Ask forge clones that repository and runs an LLM agent with access to that repository that consumers can query.

## Usage

```bash
bun install
bun run test-ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```

## TODOS

- [ ] Test with a specific forge revision (commit/branch/tags)
- [ ] Test if model is able to access other repos in workdir
  - [ ] Explore sandboxing to prevent access to other repos in workdir
