import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { MAX_TOOL_ITERATIONS, MODEL_NAME, MODEL_PROVIDER } from "../../src/config";
import { AskForgeClient, buildDefaultSystemPrompt, nullLogger } from "../../src/index";
import { JUDGE_SYSTEM_PROMPT } from "../../src/prompt";
import { type EvalRow, parseCsv, writeCsvString } from "./csv";
import { generateReport } from "./generate-report";

// =============================================================================
// LLM Judge (commented out — currently using link validation instead)
// =============================================================================

const JUDGE_MODEL_PROVIDER = "anthropic";
const JUDGE_MODEL_NAME = "claude-sonnet-4-5";

type JudgeVerdict = "yes" | "no" | "error";

interface JudgeResult {
	is_answer_relevant: JudgeVerdict;
	is_evidence_supported: JudgeVerdict;
	is_evidence_linked: JudgeVerdict;
	misc_feedback: string;
}

async function judge(question: string, answer: string): Promise<JudgeResult> {
	// biome-ignore lint/suspicious/noExplicitAny: model ID not yet in SDK types
	const model = getModel(JUDGE_MODEL_PROVIDER, JUDGE_MODEL_NAME as any);

	const userMessage = `## Question
${question}

## Answer
${answer}`;

	const response = await completeSimple(model, {
		systemPrompt: JUDGE_SYSTEM_PROMPT,
		messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
	});

	const text = response.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { type: "text"; text: string }).text)
		.join("");

	// Strip markdown code fences if present
	const cleaned = text
		.replace(/^```(?:json)?\s*\n?/m, "")
		.replace(/\n?```\s*$/m, "")
		.trim();

	const parsed = JSON.parse(cleaned) as JudgeResult;

	// Normalize yes/no values
	const normalize = (field: string, v: string | undefined): JudgeVerdict => {
		if (v == null) {
			console.error(`Judge error: field "${field}" is missing from response`);
			return "error";
		}
		const lower = v.toLowerCase();
		if (lower.startsWith("yes")) return "yes";
		if (lower.startsWith("no")) return "no";
		console.error(`Judge error: field "${field}" has unrecognized value: "${v}"`);
		return "error";
	};

	return {
		is_answer_relevant: normalize("is_answer_relevant", parsed.is_answer_relevant),
		is_evidence_supported: normalize("is_evidence_supported", parsed.is_evidence_supported),
		is_evidence_linked: normalize("is_evidence_linked", parsed.is_evidence_linked),
		misc_feedback: typeof parsed.misc_feedback === "string" ? parsed.misc_feedback : "",
	};
}

// =============================================================================
// Dataset Loading
// =============================================================================

async function loadRowsFromCsv(path: string): Promise<EvalRow[]> {
	const csvContent = await readFile(path, "utf-8");
	const parsed = parseCsv(csvContent);
	if (!parsed.ok) {
		throw new Error(parsed.error);
	}
	return parsed.rows;
}

// =============================================================================
// Main
// =============================================================================

async function runEval(inputPath: string): Promise<void> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
	const reportsDir = new URL("reports/", import.meta.url).pathname;
	await mkdir(reportsDir, { recursive: true });
	const outputPath = `${reportsDir}eval_${timestamp}.csv`;

	let rows: EvalRow[];
	try {
		rows = await loadRowsFromCsv(inputPath);
	} catch (error) {
		console.error(`Error loading dataset: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	console.log(`Reading dataset from: ${inputPath}`);
	console.log(`Found ${rows.length} rows to evaluate\n`);

	// Deduplicate: group rows by (repository, commit_id, question) so we call ask() once per unique combo
	type RowKey = string;
	const makeKey = (r: EvalRow): RowKey => `${r.repository}::${r.commit_id}::${r.question}`;

	// Group unique questions by (repo, commit) so we can reuse a single session per repo+commit
	type RepoKey = string;
	const makeRepoKey = (r: { repository: string; commit_id: string }): RepoKey => `${r.repository}::${r.commit_id}`;

	const questionsByRepo = new Map<RepoKey, { repository: string; commit_id: string; questions: Map<RowKey, string> }>();
	for (const row of rows) {
		const repoKey = makeRepoKey(row);
		let group = questionsByRepo.get(repoKey);
		if (!group) {
			group = {
				repository: row.repository,
				commit_id: row.commit_id,
				questions: new Map(),
			};
			questionsByRepo.set(repoKey, group);
		}
		const rowKey = makeKey(row);
		if (!group.questions.has(rowKey)) {
			group.questions.set(rowKey, row.question);
		}
	}

	const totalQuestions = [...questionsByRepo.values()].reduce((sum, g) => sum + g.questions.size, 0);

	const results = new Map<
		RowKey,
		{
			answer: string;
			toolCalls: string;
			filesRead: string;
			inferenceTimeMs: number;
			brokenLinkRatio: string;
		}
	>();

	const client = new AskForgeClient(
		{
			provider: MODEL_PROVIDER,
			model: MODEL_NAME,
			maxIterations: MAX_TOOL_ITERATIONS,
		},
		nullLogger,
	);

	let questionIdx = 0;
	for (const [, { repository, commit_id, questions }] of questionsByRepo) {
		let session: Awaited<ReturnType<typeof client.connect>> | null = null;

		try {
			session = await client.connect(repository, { commitish: commit_id });
		} catch (error) {
			console.error(
				`  ✗ Connect error for ${repository} @ ${commit_id.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
			);
			for (const [rowKey] of questions) {
				results.set(rowKey, { answer: "", toolCalls: "", filesRead: "", inferenceTimeMs: 0, brokenLinkRatio: "" });
			}
			continue;
		}

		for (const [rowKey, question] of questions) {
			questionIdx++;
			console.log(
				`\n[${questionIdx}/${totalQuestions}] Asking: "${question.slice(0, 80)}${question.length > 80 ? "..." : ""}"`,
			);
			console.log(`  Repo: ${repository} @ ${commit_id.slice(0, 12)}`);

			try {
				session.replaceMessages([]);
				const askResult = await session.ask(question);
				const secs = (askResult.inferenceTimeMs / 1000).toFixed(1);
				console.log(
					`  ✓ Got response (${askResult.response.length} chars, ${askResult.toolCalls.length} tool calls, ${secs}s, ${askResult.totalLinks} links, ${askResult.invalidLinks.length} broken)`,
				);

				// Format tool calls as a bulleted markdown list
				const toolCallsStr = askResult.toolCalls
					.map((tc) => `- **${tc.name}**(${JSON.stringify(tc.arguments)})`)
					.join("\n");

				// Extract file names from read tool calls
				const filesReadStr = askResult.toolCalls
					.filter((tc) => tc.name === "read")
					.map((tc) => {
						const filePath = String(tc.arguments.path ?? tc.arguments.file ?? "");
						const fileName = filePath.split("/").pop() || filePath;
						return `- ${fileName}`;
					})
					.join("\n");

				// Broken links as ratio string
				const total = askResult.totalLinks;
				const broken = askResult.invalidLinks.length;
				const brokenLinkRatio = total > 0 ? `${broken}/${total}` : "0/0";

				results.set(rowKey, {
					answer: askResult.response,
					toolCalls: toolCallsStr,
					filesRead: filesReadStr,
					inferenceTimeMs: askResult.inferenceTimeMs,
					brokenLinkRatio,
				});
			} catch (error) {
				console.error(`  ✗ Ask error: ${error instanceof Error ? error.message : String(error)}`);
				results.set(rowKey, { answer: "", toolCalls: "", filesRead: "", inferenceTimeMs: 0, brokenLinkRatio: "" });
			}
		}

		session.close();
	}

	// Write results back to rows
	const resultRows: EvalRow[] = rows.map((row) => {
		const key = makeKey(row);
		const result = results.get(key);

		return {
			...row,
			answer: result?.answer ?? "",
			is_answer_relevant: "",
			is_evidence_supported: "",
			is_evidence_linked: "",
			misc_feedback: "",
			broken_link_ratio: result?.brokenLinkRatio ?? "",
			tool_calls: result?.toolCalls ?? "",
			files_read: result?.filesRead ?? "",
			inference_time_ms: String(result?.inferenceTimeMs ?? 0),
		};
	});

	const output = writeCsvString(resultRows);
	await writeFile(outputPath, output, "utf-8");
	console.log(`\n✓ Results written to: ${outputPath}`);

	// Print summary
	const total = resultRows.length;
	const relevant = resultRows.filter((r) => r.is_answer_relevant === "yes").length;
	const evidenced = resultRows.filter((r) => r.is_evidence_supported === "yes").length;
	const linked = resultRows.filter((r) => r.is_evidence_linked === "yes").length;

	// Aggregate broken link ratios
	let sumTotalLinks = 0;
	let sumBrokenLinks = 0;
	for (const r of resultRows) {
		const parts = r.broken_link_ratio.split("/");
		if (parts.length === 2) {
			sumBrokenLinks += Number(parts[0]);
			sumTotalLinks += Number(parts[1]);
		}
	}

	console.log("\n--- Summary ---");
	console.log(`Total rows:          ${total}`);
	console.log(`Broken links:        ${sumBrokenLinks}/${sumTotalLinks}`);

	// Generate HTML report with same timestamp
	// Use first row's repo to build a representative system prompt for the report
	const sampleRow = rows[0];
	const systemPrompt = sampleRow ? buildDefaultSystemPrompt(sampleRow.repository, sampleRow.commit_id) : "(no rows)";

	const reportPath = `${reportsDir}eval-${timestamp}-report.html`;
	const reportHtml = await generateReport(
		output,
		{
			total,
			relevant,
			evidenced,
			linked,
			brokenLinkRatio: sumTotalLinks > 0 ? `${sumBrokenLinks}/${sumTotalLinks}` : "0/0",
		},
		timestamp,
		systemPrompt,
	);
	await writeFile(reportPath, reportHtml, "utf-8");
	console.log(`\n✓ Report written to: ${reportPath}`);
}

// CLI entry point
const inputPath = process.argv[2];
if (!inputPath) {
	console.error("Usage: bun run eval/run-eval.ts <path-to-dataset.csv>");
	process.exit(1);
}

await runEval(inputPath);
