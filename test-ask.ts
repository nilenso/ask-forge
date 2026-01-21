import { ask, connect } from "./index";

const repoUrl = process.argv[2];
const question = process.argv[3];

if (!repoUrl || !question) {
	console.error("Usage: bun run test-ask.ts <repo-url> <question>");
	process.exit(1);
}

console.log(`Connecting to ${repoUrl}...`);
const repo = await connect(repoUrl);
console.log(`Connected to ${repo.localPath}\n`);
console.log(`Question: ${question}\n`);
console.log("Asking...\n");

const result = await ask(repo, question);

console.log(JSON.stringify(result, null, 2));
