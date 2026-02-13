import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { MAX_TOOL_ITERATIONS, MODEL_NAME, MODEL_PROVIDER, SYSTEM_PROMPT } from "../../src/config";
import { AskForgeClient, nullLogger } from "../../src/index";
import { generateReport } from "./generate-report";

// =============================================================================
// Types
// =============================================================================

interface EvalRow {
	session_id: string;
	repository: string;
	commit_id: string;
	question: string;
	is_answer_relevant: string;
	is_evidence_supported: string;
	is_clear_and_readable: string;
	misc_feedback: string;
	answer: string;
}

interface JudgeResult {
	is_answer_relevant: "yes" | "no";
	is_evidence_supported: "yes" | "no";
	is_clear_and_readable: "yes" | "no";
	misc_feedback: string;
}

// =============================================================================
// CSV Parsing / Writing
// =============================================================================

/**
 * Parse CSV content into rows, correctly handling:
 * - Newlines inside quoted fields
 * - Escaped quotes (doubled "")
 * - Commas inside quoted fields
 */
const REQUIRED_COLUMNS = ["session_id", "repository", "commit_id", "question"] as const;

const OUTPUT_COLUMNS = [
	"session_id",
	"repository",
	"commit_id",
	"question",
	"is_answer_relevant",
	"is_evidence_supported",
	"is_clear_and_readable",
	"misc_feedback",
	"answer",
] as const;

type ParseResult = { ok: true; rows: EvalRow[] } | { ok: false; error: string };

function parseCsv(content: string): ParseResult {
	const records = parseCsvRecords(content);
	if (records.length === 0) {
		return { ok: false, error: "CSV file is empty" };
	}

	// Validate header row
	const header = records[0] as string[];
	const missing = REQUIRED_COLUMNS.filter((col) => !header.includes(col));
	if (missing.length > 0) {
		return {
			ok: false,
			error: `Missing required columns: ${missing.join(", ")}\n\nExpected CSV header (at minimum):\n  ${REQUIRED_COLUMNS.join(",")}`,
		};
	}

	// Build column index map so column order doesn't matter
	const colIndex = Object.fromEntries(header.map((col, idx) => [col.trim(), idx])) as Record<string, number>;

	if (records.length < 2) {
		return { ok: false, error: "CSV file has a header but no data rows" };
	}

	const rows: EvalRow[] = [];
	for (let i = 1; i < records.length; i++) {
		const fields = records[i] as string[];
		rows.push({
			session_id: fields[colIndex.session_id as number] ?? "",
			repository: fields[colIndex.repository as number] ?? "",
			commit_id: fields[colIndex.commit_id as number] ?? "",
			question: fields[colIndex.question as number] ?? "",
			answer: "",
			is_answer_relevant: "",
			is_evidence_supported: "",
			is_clear_and_readable: "",
			misc_feedback: "",
		});
	}
	return { ok: true, rows };
}

/** Parse full CSV content into an array of records (each record is an array of field strings) */
function parseCsvRecords(content: string): string[][] {
	const records: string[][] = [];
	let current = "";
	let inQuotes = false;
	let fields: string[] = [];

	for (let i = 0; i < content.length; i++) {
		const ch = content[i] as string;
		if (inQuotes) {
			if (ch === '"') {
				if (i + 1 < content.length && content[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				current += ch;
			}
		} else {
			if (ch === '"') {
				inQuotes = true;
			} else if (ch === ",") {
				fields.push(current);
				current = "";
			} else if (ch === "\n" || ch === "\r") {
				// Handle \r\n
				if (ch === "\r" && i + 1 < content.length && content[i + 1] === "\n") {
					i++;
				}
				fields.push(current);
				current = "";
				// Only add non-empty records (skip trailing blank lines)
				if (fields.some((f) => f.length > 0)) {
					records.push(fields);
				}
				fields = [];
			} else {
				current += ch;
			}
		}
	}
	// Handle last record if file doesn't end with newline
	fields.push(current);
	if (fields.some((f) => f.length > 0)) {
		records.push(fields);
	}

	return records;
}

function escapeCsvField(value: string): string {
	if (value.includes(",") || value.includes('"') || value.includes("\n")) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

function rowToCsv(row: EvalRow): string {
	return OUTPUT_COLUMNS.map((col) => escapeCsvField(row[col])).join(",");
}

function writeCsvString(rows: EvalRow[]): string {
	const header = OUTPUT_COLUMNS.join(",");
	return `${[header, ...rows.map(rowToCsv)].join("\n")}\n`;
}

// =============================================================================
// LLM Judge
// =============================================================================

const JUDGE_MODEL_PROVIDER = "anthropic";
const JUDGE_MODEL_NAME = "claude-sonnet-4-5";

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator of AI-generated answers about code repositories.

You will be given:
1. A question that was asked about a code repository
2. The AI-generated answer to that question

Evaluate the answer on three criteria and respond ONLY with valid JSON (no markdown fences, no extra text):

{
  "is_answer_relevant": "yes" or "no" — Is the answer correct and relevant to the question?
  "is_evidence_supported": "yes" or "no" — Are the claims in the answer supported by evidence? Evidence would ideally be present in the codebase (file paths, function names, code snippets). If the question is generic and not specific to the codebase, evidence from the codebase is not required.
  "is_clear_and_readable": "yes" or "no" — Is the answer clear, readable, and does it present a coherent narrative that is easy to follow?
  "misc_feedback": Very concise bullet points (one per line, starting with "- ") covering your reasoning for each judgment and any other observations. Keep it skimmable — no full sentences, no fluff.
}`;

async function judge(question: string, answer: string): Promise<JudgeResult> {
	const model = getModel(JUDGE_MODEL_PROVIDER, JUDGE_MODEL_NAME);

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
	const normalize = (v: string): "yes" | "no" => (v.toLowerCase().startsWith("yes") ? "yes" : "no");

	return {
		is_answer_relevant: normalize(parsed.is_answer_relevant),
		is_evidence_supported: normalize(parsed.is_evidence_supported),
		is_clear_and_readable: normalize(parsed.is_clear_and_readable),
		misc_feedback: parsed.misc_feedback,
	};
}

// =============================================================================
// Main
// =============================================================================

async function runEval(inputPath: string): Promise<void> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
	const reportsDir = new URL("reports/", import.meta.url).pathname;
	await mkdir(reportsDir, { recursive: true });
	const outputPath = `${reportsDir}eval_${timestamp}.csv`;

	console.log(`Reading dataset from: ${inputPath}`);
	const csvContent = await readFile(inputPath, "utf-8");
	const parsed = parseCsv(csvContent);

	if (!parsed.ok) {
		console.error(`Error: ${parsed.error}`);
		process.exit(1);
	}

	const rows = parsed.rows;
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
			group = { repository: row.repository, commit_id: row.commit_id, questions: new Map() };
			questionsByRepo.set(repoKey, group);
		}
		const rowKey = makeKey(row);
		if (!group.questions.has(rowKey)) {
			group.questions.set(rowKey, row.question);
		}
	}

	const totalQuestions = [...questionsByRepo.values()].reduce((sum, g) => sum + g.questions.size, 0);

	// Run ask() + judge for each unique question, reusing sessions per repo+commit
	const results = new Map<RowKey, { answer: string; judge: JudgeResult | null }>();

	const client = new AskForgeClient(
		{
			provider: MODEL_PROVIDER,
			model: MODEL_NAME,
			systemPrompt: SYSTEM_PROMPT,
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
				results.set(rowKey, { answer: "", judge: null });
			}
			continue;
		}

		for (const [rowKey, question] of questions) {
			questionIdx++;
			console.log(
				`\n[${questionIdx}/${totalQuestions}] Asking: "${question.slice(0, 80)}${question.length > 80 ? "..." : ""}"`,
			);
			console.log(`  Repo: ${repository} @ ${commit_id.slice(0, 12)}`);

			// Ask
			let answer = "";
			try {
				session.replaceMessages([]);
				const askResult = await session.ask(question);
				answer = askResult.response;
				const secs = (askResult.inferenceTimeMs / 1000).toFixed(1);
				console.log(`  ✓ Got response (${answer.length} chars, ${askResult.toolCalls.length} tool calls, ${secs}s)`);
			} catch (error) {
				console.error(`  ✗ Ask error: ${error instanceof Error ? error.message : String(error)}`);
				results.set(rowKey, { answer: "", judge: null });
				continue;
			}

			// Judge
			let judgeResult: JudgeResult | null = null;
			try {
				judgeResult = await judge(question, answer);
				console.log(
					`  ✓ Judge: relevant=${judgeResult.is_answer_relevant} evidence=${judgeResult.is_evidence_supported} clear=${judgeResult.is_clear_and_readable}`,
				);
			} catch (error) {
				console.error(`  ✗ Judge error: ${error instanceof Error ? error.message : String(error)}`);
			}

			results.set(rowKey, { answer, judge: judgeResult });
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
			is_answer_relevant: result?.judge?.is_answer_relevant ?? "",
			is_evidence_supported: result?.judge?.is_evidence_supported ?? "",
			is_clear_and_readable: result?.judge?.is_clear_and_readable ?? "",
			misc_feedback: result?.judge?.misc_feedback ?? "",
		};
	});

	const output = writeCsvString(resultRows);
	await writeFile(outputPath, output, "utf-8");
	console.log(`\n✓ Results written to: ${outputPath}`);

	// Print summary
	const total = resultRows.length;
	const relevant = resultRows.filter((r) => r.is_answer_relevant === "yes").length;
	const evidenced = resultRows.filter((r) => r.is_evidence_supported === "yes").length;
	const clear = resultRows.filter((r) => r.is_clear_and_readable === "yes").length;

	console.log("\n--- Summary ---");
	console.log(`Total rows:          ${total}`);
	console.log(`Answer relevant:     ${relevant}/${total} (${((relevant / total) * 100).toFixed(1)}%)`);
	console.log(`Evidence supported:  ${evidenced}/${total} (${((evidenced / total) * 100).toFixed(1)}%)`);
	console.log(`Clear & readable:    ${clear}/${total} (${((clear / total) * 100).toFixed(1)}%)`);

	// Generate HTML report with same timestamp
	const reportPath = `${reportsDir}eval-${timestamp}-report.html`;
	const reportHtml = await generateReport(output, { total, relevant, evidenced, clear }, timestamp);
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
