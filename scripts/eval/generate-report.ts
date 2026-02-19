/**
 * Generates a self-contained HTML eval report by reading report-template.html
 * and injecting the eval data into its placeholder tokens.
 */

import { readFile } from "node:fs/promises";

interface ReportStats {
	total: number;
	complete: number;
	evidenced: number;
	linked: number;
	soundReasoning: number;
	brokenLinkRatio: string;
}

/**
 * Generate a standalone HTML report string by populating the template.
 *
 * @param csvContent   - The raw CSV string (same content written to the output file)
 * @param stats        - Summary counts
 * @param timestamp    - The same timestamp string used for the CSV filename
 * @param systemPrompt - The system prompt used for this eval run
 */
export async function generateReport(
	csvContent: string,
	stats: ReportStats,
	timestamp: string,
	systemPrompt: string,
): Promise<string> {
	const templatePath = new URL("report-template.html", import.meta.url).pathname;
	let html = await readFile(templatePath, "utf-8");

	const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");

	// JSON.stringify produces a safe string for embedding in a <script type="application/json"> block.
	// We only need to guard against a literal "</script>" inside the data.
	const escapeScript = (s: string) => JSON.stringify(s).replace(/<\/script>/gi, "<\\/script>");
	const csvJson = escapeScript(csvContent);
	const systemPromptJson = escapeScript(systemPrompt);

	const replacements: Record<string, string> = {
		"{{TIMESTAMP}}": timestamp,
		"{{TOTAL}}": String(stats.total),
		"{{COMPLETE_PCT}}": pct(stats.complete, stats.total),
		"{{COMPLETE_COUNT}}": String(stats.complete),
		"{{EVIDENCED_PCT}}": pct(stats.evidenced, stats.total),
		"{{EVIDENCED_COUNT}}": String(stats.evidenced),
		"{{LINKED_PCT}}": pct(stats.linked, stats.total),
		"{{LINKED_COUNT}}": String(stats.linked),
		"{{SOUND_PCT}}": pct(stats.soundReasoning, stats.total),
		"{{SOUND_COUNT}}": String(stats.soundReasoning),
		"{{BROKEN_LINK_RATIO}}": stats.brokenLinkRatio,
		"{{CSV_JSON}}": csvJson,
		"{{SYSTEM_PROMPT_JSON}}": systemPromptJson,
	};

	for (const [token, value] of Object.entries(replacements)) {
		html = html.replaceAll(token, value);
	}

	return html;
}
