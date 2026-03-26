# Usage Instructions

1. Install dependencies with `bun install`
2. See README.md for the library API (`connect`, `Session`, etc.)
3. For sandboxed execution, see the `sandbox/` directory and `docker-compose.yml`
4. The sandbox requires gVisor (`runsc`) and must run rootful with podman:
   - `sudo just sandbox-up` / `sudo just sandbox-down`
   - Podman needs `--in-pod=false` (already in justfile) because pod infra containers conflict with gVisor runtime
   - `/etc/containers/containers.conf` must have `runsc = ["/usr/local/bin/runsc"]` without `--rootless=true`
   - Docker works without extra config
5. Security tests: `bun run playground/security-tests.ts sandbox` (requires running sandbox)
6. Troubleshooting sandbox:
   - Stale gVisor state after failed starts: clean up with `sudo rm -rf /var/run/runsc/*` then retry
   - `podman exec` does not work with gVisor's `runsc` runtime — use the HTTP API instead
   - Port already in use: run `sudo podman rm -af` to clean up before restarting
   - The seccomp BPF filter is arch-specific and must be at `/etc/seccomp/{arch}/net-block.bpf` inside the container (handled by Containerfile)
   - DNS: gVisor doesn't work with Docker/Podman's embedded DNS proxy (`127.0.0.11`). The `docker-compose.yml` has explicit `dns: [8.8.8.8, 8.8.4.4]` to work around this — do not remove it
   - If git clone fails with "could not resolve host" inside the container, check that the `dns` entries in `docker-compose.yml` are present and reachable
   - CNI firewall plugin: Podman's CNI `firewall` plugin may be too old for CNI spec 1.0.0, causing `plugin firewall does not support config version "1.0.0"` warnings and broken networking. Fix by upgrading CNI plugins: `curl -L https://github.com/containernetworking/plugins/releases/download/v1.6.2/cni-plugins-linux-arm64-v1.6.2.tgz | sudo tar -xz -C /usr/lib/cni/`

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
