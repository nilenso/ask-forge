import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
// import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { MAX_TOOL_ITERATIONS, MODEL_NAME, MODEL_PROVIDER } from "../../src/config";
import { AskForgeClient, buildDefaultSystemPrompt, nullLogger } from "../../src/index";
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
	is_evidence_linked: string;
	misc_feedback: string;
	answer: string;
	tool_call_count: string;
	inference_time_ms: string;
	total_links: string;
	broken_links: string;
}

// type JudgeVerdict = "yes" | "no" | "error";

// interface JudgeResult {
// 	is_answer_relevant: JudgeVerdict;
// 	is_evidence_supported: JudgeVerdict;
// 	is_evidence_linked: JudgeVerdict;
// 	misc_feedback: string;
// }

// =============================================================================
// CSV Parsing / Writing
// =============================================================================

/**
 * Parse CSV content into rows, correctly handling:
 * - Newlines inside quoted fields
 * - Escaped quotes (doubled "")
 * - Commas inside quoted fields
 */
const REQUIRED_COLUMNS = ["repository", "commit_id", "question"] as const;

const OUTPUT_COLUMNS = [
	"session_id",
	"repository",
	"commit_id",
	"question",
	"is_answer_relevant",
	"is_evidence_supported",
	"is_evidence_linked",
	"misc_feedback",
	"answer",
	"tool_call_count",
	"inference_time_ms",
	"total_links",
	"broken_links",
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
	const hasSessionId = header.includes("session_id");
	const hasId = header.includes("id");
	if (missing.length > 0) {
		return {
			ok: false,
			error: `Missing required columns: ${missing.join(", ")}\n\nExpected CSV header (at minimum):\n  ${REQUIRED_COLUMNS.join(",")}`,
		};
	}
	if (!hasSessionId && !hasId) {
		return {
			ok: false,
			error: 'Missing identifier column: expected either "session_id" or "id"',
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
			session_id: hasSessionId ? (fields[colIndex["session_id"]!] ?? "") : (fields[colIndex["id"]!] ?? ""),
			repository: fields[colIndex["repository"]!] ?? "",
			commit_id: fields[colIndex["commit_id"]!] ?? "",
			question: fields[colIndex["question"]!] ?? "",
			answer: "",
			is_answer_relevant: "",
			is_evidence_supported: "",
			is_evidence_linked: "",
			misc_feedback: "",
			tool_call_count: "",
			inference_time_ms: "",
			total_links: "",
			broken_links: "",
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
	return [header, ...rows.map(rowToCsv)].join("\n") + "\n";
}

// =============================================================================
// LLM Judge (commented out — currently using link validation instead)
// =============================================================================

// const JUDGE_MODEL_PROVIDER = "anthropic";
// const JUDGE_MODEL_NAME = "claude-sonnet-4-5";
//
// const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator of repository Q&A answers.
//
// You will receive:
// 1) A question
// 2) An answer
//
// Important constraints:
// - Evaluate ONLY from the answer text itself.
// - Do NOT use outside knowledge or assumptions.
// - If evidence is missing in the answer, treat it as missing.
//
// Return ONLY valid JSON with exactly these keys:
// {
//   "is_answer_relevant": "yes" | "no",
//   "is_evidence_supported": "yes" | "no",
//   "is_evidence_linked": "yes" | "no",
//   "misc_feedback": "string"
// }
//
// Rubric:
// - is_answer_relevant = "yes" only if the answer directly addresses the question and has no major contradiction.
// - is_evidence_supported = "yes" only if all repository-specific claims are explicitly supported by evidence in the answer. If any material claim lacks support, return "no".
// - is_evidence_linked = "yes" only if EVERY code reference in the answer is linked with a valid GitHub/GitLab URL pointing to a specific file and line in the repository under evaluation.
//   Code references include files, functions, classes, methods, variables/constants, types, modules, and snippets.
//   Accepted examples:
//   - https://github.com/<org>/<repo>/blob/<commit_or_branch>/path/to/file.ts#L42
//   - https://gitlab.com/<group>/<repo>/-/blob/<commit_or_branch>/path/to/file.ts#L42
//   - ranges like #L42-L55
//   Not acceptable:
//   - plain text paths like src/a.ts:42
//   - relative links
//   - links without line anchors
//   - links to other repositories
//   If the answer contains zero code references, return "yes".`;
//
// type JudgeVerdict = "yes" | "no" | "error";
//
// interface JudgeResult {
// 	is_answer_relevant: JudgeVerdict;
// 	is_evidence_supported: JudgeVerdict;
// 	is_evidence_linked: JudgeVerdict;
// 	misc_feedback: string;
// }
//
// async function judge(question: string, answer: string): Promise<JudgeResult> {
// 	const model = getModel(JUDGE_MODEL_PROVIDER, JUDGE_MODEL_NAME);
//
// 	const userMessage = `## Question
// ${question}
//
// ## Answer
// ${answer}`;
//
// 	const response = await completeSimple(model, {
// 		systemPrompt: JUDGE_SYSTEM_PROMPT,
// 		messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
// 	});
//
// 	const text = response.content
// 		.filter((b) => b.type === "text")
// 		.map((b) => (b as { type: "text"; text: string }).text)
// 		.join("");
//
// 	// Strip markdown code fences if present
// 	const cleaned = text
// 		.replace(/^```(?:json)?\s*\n?/m, "")
// 		.replace(/\n?```\s*$/m, "")
// 		.trim();
//
// 	const parsed = JSON.parse(cleaned) as JudgeResult;
//
// 	// Normalize yes/no values
// 	const normalize = (field: string, v: string | undefined): JudgeVerdict => {
// 		if (v == null) {
// 			console.error(`Judge error: field "${field}" is missing from response`);
// 			return "error";
// 		}
// 		const lower = v.toLowerCase();
// 		if (lower.startsWith("yes")) return "yes";
// 		if (lower.startsWith("no")) return "no";
// 		console.error(`Judge error: field "${field}" has unrecognized value: "${v}"`);
// 		return "error";
// 	};
//
// 	return {
// 		is_answer_relevant: normalize("is_answer_relevant", parsed.is_answer_relevant),
// 		is_evidence_supported: normalize("is_evidence_supported", parsed.is_evidence_supported),
// 		is_evidence_linked: normalize("is_evidence_linked", parsed.is_evidence_linked),
// 		misc_feedback: typeof parsed.misc_feedback === "string" ? parsed.misc_feedback : "",
// 	};
// }

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
		{ answer: string; toolCallCount: number; inferenceTimeMs: number; totalLinks: number; brokenLinks: number }
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
				results.set(rowKey, { answer: "", toolCallCount: 0, inferenceTimeMs: 0, totalLinks: 0, brokenLinks: 0 });
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
				results.set(rowKey, {
					answer: askResult.response,
					toolCallCount: askResult.toolCalls.length,
					inferenceTimeMs: askResult.inferenceTimeMs,
					totalLinks: askResult.totalLinks,
					brokenLinks: askResult.invalidLinks.length,
				});
			} catch (error) {
				console.error(`  ✗ Ask error: ${error instanceof Error ? error.message : String(error)}`);
				results.set(rowKey, { answer: "", toolCallCount: 0, inferenceTimeMs: 0, totalLinks: 0, brokenLinks: 0 });
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
			tool_call_count: String(result?.toolCallCount ?? 0),
			inference_time_ms: String(result?.inferenceTimeMs ?? 0),
			total_links: String(result?.totalLinks ?? 0),
			broken_links: String(result?.brokenLinks ?? 0),
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
	const sumTotalLinks = resultRows.reduce((s, r) => s + Number(r.total_links), 0);
	const sumBrokenLinks = resultRows.reduce((s, r) => s + Number(r.broken_links), 0);

	console.log("\n--- Summary ---");
	console.log(`Total rows:          ${total}`);
	console.log(`Total links:         ${sumTotalLinks}`);
	console.log(`Broken links:        ${sumBrokenLinks}`);

	// Generate HTML report with same timestamp
	// Use first row's repo to build a representative system prompt for the report
	const sampleRow = rows[0];
	const systemPrompt = sampleRow ? buildDefaultSystemPrompt(sampleRow.repository, sampleRow.commit_id) : "(no rows)";

	const reportPath = `${reportsDir}eval-${timestamp}-report.html`;
	const reportHtml = await generateReport(
		output,
		{ total, relevant, evidenced, linked, totalLinks: sumTotalLinks, brokenLinks: sumBrokenLinks },
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
