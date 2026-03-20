# Run all tests
test:
    bun test

# Run isolation layer tests (bwrap + seccomp)
isolation-tests:
    bun test test/sandbox/isolation/isolation.test.ts

# Run sandbox integration tests (requires running sandbox)
sandbox-tests: sandbox-up
    @echo "Waiting for sandbox..."
    @sleep 2
    bun test test/sandbox/sandbox.integration.test.ts || true
    podman-compose down

# Run all sandbox tests (isolation + integration)
sandbox-all-tests: isolation-tests sandbox-tests

# Build sandbox container
sandbox-build:
    podman-compose build

# Start sandbox container
sandbox-up: sandbox-build
    podman-compose up -d

# Stop sandbox container
sandbox-down:
    podman-compose down

# View sandbox logs
sandbox-logs:
    podman-compose logs -f

# Start Langfuse observability stack
langfuse-up:
    docker compose up -d langfuse-postgres langfuse-redis langfuse-clickhouse langfuse-minio langfuse-minio-init
    @echo "Waiting for infra services..."
    @sleep 5
    docker compose up -d langfuse-worker langfuse-web
    @echo "Langfuse starting at http://localhost:3000"

# Stop Langfuse stack
langfuse-down:
    docker compose down langfuse-web langfuse-worker langfuse-minio-init langfuse-minio langfuse-clickhouse langfuse-redis langfuse-postgres

# View Langfuse logs
langfuse-logs:
    docker compose logs -f langfuse-web langfuse-worker
