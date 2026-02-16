/**
 * Generates a self-contained HTML eval report by reading report-template.html
 * and injecting the eval data into its placeholder tokens.
 */

import { readFile } from "node:fs/promises";

interface ReportStats {
	total: number;
	relevant: number;
	evidenced: number;
	linked: number;
}

/**
 * Generate a standalone HTML report string by populating the template.
 *
 * @param csvContent - The raw CSV string (same content written to the output file)
 * @param stats      - Summary counts
 * @param timestamp  - The same timestamp string used for the CSV filename
 */
export async function generateReport(csvContent: string, stats: ReportStats, timestamp: string): Promise<string> {
	const templatePath = new URL("report-template.html", import.meta.url).pathname;
	let html = await readFile(templatePath, "utf-8");

	const pct = (n: number) => (stats.total > 0 ? ((n / stats.total) * 100).toFixed(1) : "0.0");

	// JSON.stringify produces a safe string for embedding in a <script type="application/json"> block.
	// We only need to guard against a literal "</script>" inside the data.
	const csvJson = JSON.stringify(csvContent).replace(/<\/script>/gi, "<\\/script>");

	const replacements: Record<string, string> = {
		"{{TIMESTAMP}}": timestamp,
		"{{TOTAL}}": String(stats.total),
		"{{RELEVANT_PCT}}": pct(stats.relevant),
		"{{RELEVANT_COUNT}}": String(stats.relevant),
		"{{EVIDENCED_PCT}}": pct(stats.evidenced),
		"{{EVIDENCED_COUNT}}": String(stats.evidenced),
		"{{LINKED_PCT}}": pct(stats.linked),
		"{{LINKED_COUNT}}": String(stats.linked),
		"{{CSV_JSON}}": csvJson,
	};

	for (const [token, value] of Object.entries(replacements)) {
		html = html.replaceAll(token, value);
	}

	return html;
}
