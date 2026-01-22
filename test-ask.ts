import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "./index";

// Test parallel connects with the same git repo but different revisions
const repoUrl = "https://github.com/nilenso/goose";
const revision1 = "0.5.0";
const revision2 = "0.6.0";

console.log(`Testing parallel connects to ${repoUrl}`);
console.log(`Revision 1: ${revision1}`);
console.log(`Revision 2: ${revision2}`);
console.log();

console.log("Connecting in parallel...");
const [repo1, repo2] = await Promise.all([
	connect(repoUrl, { commitish: revision1 }),
	connect(repoUrl, { commitish: revision2 }),
]);

console.log(`\nRepo 1 (${revision1}):`);
console.log(`  Path: ${repo1.localPath}`);
console.log(`  SHA: ${repo1.commitish}`);

console.log(`\nRepo 2 (${revision2}):`);
console.log(`  Path: ${repo2.localPath}`);
console.log(`  SHA: ${repo2.commitish}`);

// Verify they have different paths (worktrees)
if (repo1.localPath === repo2.localPath) {
	console.error("\nERROR: Both repos have the same local path!");
	process.exit(1);
}

// Verify they share the same cache path
if (repo1.cachePath !== repo2.cachePath) {
	console.error("\nERROR: Repos should share the same cache path!");
	process.exit(1);
}

console.log("\n✓ Both repos connected successfully with separate worktrees");
console.log(`✓ Shared cache path: ${repo1.cachePath}`);

// Verify pom.xml has the correct version for each revision
async function extractVersion(repoPath: string): Promise<string | null> {
	const pomPath = join(repoPath, "pom.xml");
	const content = await readFile(pomPath, "utf-8");
	const match = content.match(/<version>([^<]+)<\/version>/);
	return match?.[1] ?? null;
}

console.log("\nVerifying pom.xml versions...");
const [version1, version2] = await Promise.all([extractVersion(repo1.localPath), extractVersion(repo2.localPath)]);

console.log(`  Repo 1 pom.xml version: ${version1}`);
console.log(`  Repo 2 pom.xml version: ${version2}`);

if (version1 !== revision1) {
	console.error(`\nERROR: Repo 1 pom.xml version (${version1}) does not match expected (${revision1})!`);
	process.exit(1);
}

if (version2 !== revision2) {
	console.error(`\nERROR: Repo 2 pom.xml version (${version2}) does not match expected (${revision2})!`);
	process.exit(1);
}

console.log(`\n✓ pom.xml version ${revision1} verified in revision ${revision1}`);
console.log(`✓ pom.xml version ${revision2} verified in revision ${revision2}`);
