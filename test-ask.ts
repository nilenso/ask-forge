import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_TOOL_ITERATIONS, MODEL_NAME, MODEL_PROVIDER, SYSTEM_PROMPT } from "./config";
import { AskForgeClient } from "./index";

// Test parallel connects with the same git repo but different revisions
const repoUrl = "https://github.com/nilenso/goose";
const revision1 = "0.5.0";
const revision2 = "0.6.0";

const client = new AskForgeClient({
	provider: MODEL_PROVIDER,
	model: MODEL_NAME,
	systemPrompt: SYSTEM_PROMPT,
	maxIterations: MAX_TOOL_ITERATIONS,
});

console.log(`Testing parallel connects to ${repoUrl}`);
console.log(`Revision 1: ${revision1}`);
console.log(`Revision 2: ${revision2}`);
console.log();

console.log("Connecting in parallel...");
const [session1, session2] = await Promise.all([
	client.connect(repoUrl, { commitish: revision1 }),
	client.connect(repoUrl, { commitish: revision2 }),
]);

console.log(`\nSession 1 (${revision1}):`);
console.log(`  ID: ${session1.id}`);
console.log(`  Path: ${session1.repo.localPath}`);
console.log(`  SHA: ${session1.repo.commitish}`);

console.log(`\nSession 2 (${revision2}):`);
console.log(`  ID: ${session2.id}`);
console.log(`  Path: ${session2.repo.localPath}`);
console.log(`  SHA: ${session2.repo.commitish}`);

// Verify they have different paths (worktrees)
if (session1.repo.localPath === session2.repo.localPath) {
	console.error("\nERROR: Both repos have the same local path!");
	process.exit(1);
}

// Verify they share the same cache path
if (session1.repo.cachePath !== session2.repo.cachePath) {
	console.error("\nERROR: Repos should share the same cache path!");
	process.exit(1);
}

console.log("\n✓ Both sessions connected successfully with separate worktrees");
console.log(`✓ Shared cache path: ${session1.repo.cachePath}`);

// Verify pom.xml has the correct version for each revision
async function extractVersion(repoPath: string): Promise<string | null> {
	const pomPath = join(repoPath, "pom.xml");
	const content = await readFile(pomPath, "utf-8");
	const match = content.match(/<version>([^<]+)<\/version>/);
	return match?.[1] ?? null;
}

console.log("\nVerifying pom.xml versions...");
const [version1, version2] = await Promise.all([
	extractVersion(session1.repo.localPath),
	extractVersion(session2.repo.localPath),
]);

console.log(`  Session 1 pom.xml version: ${version1}`);
console.log(`  Session 2 pom.xml version: ${version2}`);

if (version1 !== revision1) {
	console.error(`\nERROR: Session 1 pom.xml version (${version1}) does not match expected (${revision1})!`);
	process.exit(1);
}

if (version2 !== revision2) {
	console.error(`\nERROR: Session 2 pom.xml version (${version2}) does not match expected (${revision2})!`);
	process.exit(1);
}

console.log(`\n✓ pom.xml version ${revision1} verified in revision ${revision1}`);
console.log(`✓ pom.xml version ${revision2} verified in revision ${revision2}`);

// Clean up sessions
await session1.close();
await session2.close();
console.log("\n✓ Sessions closed");
