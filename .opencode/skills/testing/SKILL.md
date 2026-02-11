# Testing Skill for ask-forge

Write and maintain tests following ask-forge testing patterns using Bun test framework.

## Test Framework

- **Runtime**: Bun
- **Test command**: `bun test`
- **Imports**: `import { describe, expect, test, beforeAll, beforeEach, afterEach, afterAll } from "bun:test"`

## Test File Conventions

- Source code lives in `src/`
- Tests live in `test/` with a mirrored folder structure
- Example: `src/services/session.ts` -> `test/services/session.test.ts`
- Integration tests use `.integration.test.ts` suffix

## Test Structure Pattern

```typescript
import { describe, expect, test } from "bun:test";

describe("ClassName", () => {
  describe("methodName", () => {
    test("describes expected behavior", () => {
      // Arrange
      const sut = createSubjectUnderTest();
      
      // Act
      const result = sut.method();
      
      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

## Mock Factory Pattern

Create factory functions to generate test data with sensible defaults. This keeps tests readable and DRY:

```typescript
// Mock factory for domain objects
function createMockRepo(overrides?: Partial<Repo>): Repo {
  return {
    url: "https://github.com/test/repo",
    localPath: "/tmp/test-repo",
    cachePath: "/tmp/cache",
    commitish: "abc123",
    ...overrides,
  };
}

// Mock factory for config objects with defaults
function createMockConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    model: {} as Model<Api>,
    systemPrompt: "You are a test assistant",
    tools: [],
    maxIterations: 5,
    executeTool: async () => "mock result",
    logger: nullLogger,
    ...overrides,
  };
}
```

## Dependency Injection for Testability

Classes should accept dependencies through constructors:

```typescript
// Production code
class Session {
  constructor(
    private repo: Repo,
    private config: SessionConfig  // Config includes injectable dependencies
  ) {}
}

// Test code - inject mocks via config
const session = new Session(
  createMockRepo(),
  createMockConfig({ logger: capturingLogger })
);
```

## Capturing Logger Pattern

For testing logging behavior without console output:

```typescript
function createCapturingLogger(): { 
  logger: Logger; 
  logs: string[]; 
  errors: string[] 
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    logger: {
      log(label: string, content: string) {
        logs.push(`${label}: ${content}`);
      },
      error(label: string, error: unknown) {
        errors.push(`${label}: ${JSON.stringify(error)}`);
      },
    },
  };
}
```

## Async Testing Patterns

```typescript
// Async test with await
test("async operation completes", async () => {
  const result = await session.ask("question");
  expect(result.response).toBeDefined();
});

// Testing rejected promises
test("throws after close", async () => {
  session.close();
  expect(session.ask("test")).rejects.toThrow("Session is closed");
});
```

## Mock Async Iterators

For testing streaming responses:

```typescript
function createMockStreamResult() {
  const events = [{ type: "text_delta", delta: "Hello" }];

  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) {
        yield event;
      }
    },
    result: async () => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Hello" }],
      usage: { input: 10, output: 5, totalTokens: 15 },
    }),
  };
}
```

## Setup and Teardown

```typescript
// Expensive setup - run once per describe block
beforeAll(async () => {
  // Database connections, file fixtures, etc.
});

// Cleanup - run after each test for isolation
afterEach(() => {
  // Reset mocks, clear state, etc.
});
```

## Fixtures vs Mock Factories

**Use fixtures (`beforeAll`) when:**
- Setup is expensive (database connections, file I/O, external services)
- Data is shared and read-only across multiple tests
- Integration tests need real file structures or config files

**Use mock factories instead when:**
- Writing unit tests with in-memory objects
- Tests modify state and need fresh isolated copies
- Tests need different property combinations

```typescript
// Fixture - expensive, shared across tests
let dbConnection: Database;

beforeAll(async () => {
  dbConnection = await connectToTestDatabase();
  await loadSeedData();
});

afterAll(async () => {
  await dbConnection.close();
});

// Mock factory - cheap, per-test with variations
test("handles missing user", () => {
  const config = createMockConfig({ user: undefined });
  // Each test gets its own isolated config
});
```

**Rule of thumb**: If setup takes >10ms or involves I/O, use fixtures with `beforeAll`. Otherwise, use mock factories for isolation.

## Test Checklist

When writing tests, verify:

- [ ] Mocks satisfy interface contracts (run `bunx tsc --noEmit`)
- [ ] Each test has a single clear assertion focus
- [ ] Async tests properly await or use `.rejects`
- [ ] No test interdependencies (tests can run in any order)
- [ ] `nullLogger` used to suppress console output in unit tests
