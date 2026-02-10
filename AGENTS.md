# Usage Instructions

1. Install dependencies with `bun install`
2. See README.md for the library API (`connect`, `Session`, etc.)
3. For sandboxed execution, see the `sandbox/` directory and `docker-compose.yml`

# Before Committing

1. Run `bun run check` (auto-fixes most lint and format issues)
2. Run `bunx tsc --noEmit` to verify type checking passes
3. Run `bun test` to ensure all tests pass
4. Manually fix any remaining errors
5. Commit

# Code Architecture Guidelines

## Refactoring Principles

- **Analyze dependencies first**: Before extracting code, map closures, imports, and shared state to understand what needs to move together
- **Work incrementally**: Extract one piece at a time, verifying after each change rather than making large sweeping changes
- **Pause to simplify**: After extraction, review for patterns like repeated parameters or duplicated logic that can be consolidated
- **Prefer classes over closures**: For objects with state and lifecycle, classes are more idiomatic in TypeScript and easier to test

## Managing Complexity

- **Reduce parameter counts**: When passing 4+ related parameters together, bundle them into a context object
- **Separate pure from stateful**: Extract stateless helpers as module-level functions; keep state management in classes
- **Make dependencies explicit**: Inject dependencies through constructors rather than importing globals, enabling testability

## Type Design

- **Use discriminated unions for results**: Prefer `{ ok: true; value: T } | { ok: false; error: E }` over exceptions for expected failures
- **Avoid `any` and loose casts**: Create specific types for external/untyped data rather than using `as` assertions
- **Export types separately**: Use `type` imports for types that don't need runtime presence

## Testing

- **Validate mocks against interfaces**: Run type checking to ensure mock objects satisfy all required interface fields
- **Inject dependencies for testability**: Design classes to accept their dependencies so tests can provide mocks
- **Separate fast from slow tests**: Use setup hooks appropriately - expensive fixtures in `beforeAll`, isolation cleanup in `afterEach`
