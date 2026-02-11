import "dotenv/config";
import { MAX_TOOL_ITERATIONS, MODEL_NAME, MODEL_PROVIDER, SYSTEM_PROMPT } from "../src/config";
import { AskForgeClient } from "../src/index";

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
		if (error.cause) console.error(`Cause: ${JSON.stringify(error.cause, null, 2)}`);
		if (error.stack) console.error(`Stack: ${error.stack}`);
	} else {
		console.error(JSON.stringify(error, null, 2));
	}
	console.error(`${"═".repeat(60)}\n`);
}

const client = new AskForgeClient({
	provider: MODEL_PROVIDER,
	model: MODEL_NAME,
	systemPrompt: SYSTEM_PROMPT,
	maxIterations: MAX_TOOL_ITERATIONS,
});

try {
	console.log(`Connecting to ${repoUrl}...`);
	const session = await client.connect(repoUrl, { commitish });
	console.log(`Connected to ${session.repo.localPath}`);
	console.log(`Session ID: ${session.id}`);
	if (session.repo.commitish) {
		console.log(`Checked out: ${session.repo.commitish}`);
	}

	console.log();
	console.log(`Question: ${question}\n`);
	console.log("Asking...\n");

	const result = await session.ask(question);
	console.log(JSON.stringify(result, null, 2));

	await session.close();
} catch (error) {
	logError("ask", error);
	console.log(
		JSON.stringify({
			prompt: question,
			toolCalls: [],
			response: `[ERROR: ${error instanceof Error ? error.message : String(error)}]`,
		}),
	);
	process.exit(1);
}
