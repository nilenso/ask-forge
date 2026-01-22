import { ask, connect } from "./index";

const repoUrl = process.argv[2];
const question = process.argv[3];
const commitish = process.argv[4];

if (!repoUrl || !question) {
	console.error("Usage: bun run test-ask.ts <repo-url> <question> [commitish]");
	console.error("  commitish: optional commit SHA, branch, tag, or relative ref (e.g., HEAD~1)");
	process.exit(1);
}

console.log(`Connecting to ${repoUrl}...`);
const repo = await connect(repoUrl, { commitish });
console.log(`Connected to ${repo.localPath}`);
if (repo.commitish) {
	console.log(`Checked out: ${repo.commitish}`);
}
console.log();
console.log(`Question: ${question}\n`);
console.log("Asking...\n");

const result = await ask(repo, question);

console.log(JSON.stringify(result, null, 2));
