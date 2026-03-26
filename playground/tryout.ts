/**
 * Playground for ad-hoc testing.
 *
 * For security vulnerability tests, see:
 *   bun run playground/security-tests.ts          # All tests
 *   bun run playground/security-tests.ts local    # Local-mode only
 *   bun run playground/security-tests.ts sandbox  # Sandbox-mode only
 */

import { AskForgeClient } from "@nilenso/ask-forge";

const client = new AskForgeClient();
const session = await client.connect("https://github.com/octocat/Hello-World");

const result = await session.ask("What is this repository about?");
console.log(result.response);

await session.close();
