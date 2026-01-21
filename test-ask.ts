import { connect, ask } from "./index";

const repoUrl = "https://github.com/nilenso/grpo-trainer";
const question = process.argv[2];

if (!question) {
	console.error("Usage: bun run test-ask.ts <question>");
	process.exit(1);
}

console.log(`Connecting to ${repoUrl}...`);
const repo = await connect(repoUrl);
console.log(`Connected to ${repo.localPath}\n`);
console.log(`Question: ${question}\n`);
console.log("Asking...\n");

const answer = await ask(repo, question);

console.log("Answer:");
console.log(answer);
