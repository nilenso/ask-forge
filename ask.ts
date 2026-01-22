import "dotenv/config";
import { ask, connect } from "./index";

const repoUrl = process.argv[2];
const question = process.argv[3];
const commitish = process.argv[4];

if (!repoUrl || !question) {
	console.error("Usage: bun run ask.ts <repo-url> <question> [commitish]");
	console.error("  commitish: optional commit SHA, branch, tag, or relative ref (e.g., HEAD~1)");
	process.exit(1);
}

function logError(stage: string, error: unknown) {
	console.error(`\n${"═".repeat(60)}`);
	console.error(`│ ERROR during: ${stage}`);
	console.error(`${"═".repeat(60)}`);
	if (error instanceof Error) {
		console.error(`Message: ${error.message}`);
		if (error.cause) {
			console.error(`Cause: ${JSON.stringify(error.cause, null, 2)}`);
		}
		if (error.stack) {
			console.error(`Stack: ${error.stack}`);
		}
	} else {
		console.error(JSON.stringify(error, null, 2));
	}
	console.error(`${"═".repeat(60)}\n`);
}

let repo: Awaited<ReturnType<typeof connect>>;
try {
	console.log(`Connecting to ${repoUrl}...`);
	repo = await connect(repoUrl, { commitish });
	console.log(`Connected to ${repo.localPath}`);
	if (repo.commitish) {
		console.log(`Checked out: ${repo.commitish}`);
	}
} catch (error) {
	logError("connect", error);
	console.log(
		JSON.stringify({
			prompt: question,
			"tool-calls": [],
			response: `[ERROR: Failed to connect to repository: ${error instanceof Error ? error.message : String(error)}]`,
		}),
	);
	process.exit(1);
}

console.log();
console.log(`Question: ${question}\n`);
console.log("Asking...\n");

try {
	const result = await ask(repo, question);
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	logError("ask", error);
	console.log(
		JSON.stringify({
			prompt: question,
			"tool-calls": [],
			response: `[ERROR: Failed to get answer: ${error instanceof Error ? error.message : String(error)}]`,
		}),
	);
	process.exit(1);
}
