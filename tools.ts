import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// Default limits for tool outputs to prevent context window overflow
const DEFAULT_READ_LINE_LIMIT = 2000;
const RG_MAX_MATCHES_PER_FILE = 50;

export const tools: Tool[] = [
	{
		name: "rg",
		description:
			"Search for a pattern in files using ripgrep. Defaults to respecting .gitignore and hidden/binary files. Supports relevance filters and output limits.",
		parameters: Type.Object({
			pattern: Type.String({ description: "The regex pattern to search for" }),
			glob: Type.Optional(
				Type.String({
					description: "File glob pattern to filter files (e.g., '*.ts', '**/*.json')",
				}),
			),
			max_count: Type.Optional(Type.Number({ description: "Max matching lines per file" })),
			max_results: Type.Optional(
				Type.Number({
					description: "Max total matches (global), enforced via head",
				}),
			),
			word: Type.Optional(Type.Boolean({ description: "Match whole words only (-w)" })),
		}),
	},
	{
		name: "fd",
		description:
			"Find files by name pattern using fd. Returns matching file paths. Defaults to respecting .gitignore and excluding hidden files. Supports relevant filters and output limits.",
		parameters: Type.Object({
			pattern: Type.String({
				description: "The regex pattern to match file names against (use --glob for glob patterns)",
			}),
			type: Type.Optional(
				Type.Union([Type.Literal("f"), Type.Literal("d"), Type.Literal("l"), Type.Literal("x")], {
					description: "Filter by type: 'f' for files, 'd' for directories, 'l' for symlinks, 'x' for executables",
				}),
			),
			extension: Type.Optional(
				Type.String({
					description: "Filter by file extension (e.g., 'ts', 'json'). Can be comma-separated for multiple extensions.",
				}),
			),
			max_depth: Type.Optional(Type.Number({ description: "Maximum directory depth to search" })),
			max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
			hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories" })),
			glob: Type.Optional(Type.Boolean({ description: "Use glob pattern instead of regex" })),
			exclude: Type.Optional(
				Type.String({
					description: "Exclude entries matching this glob pattern (e.g., 'node_modules' or '*.pyc')",
				}),
			),
			full_path: Type.Optional(
				Type.Boolean({
					description: "Match pattern against full path, not just filename",
				}),
			),
		}),
	},
	{
		name: "ls",
		description: "List files and directories in a given path.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "Path to list, relative to repository root. Defaults to root if not specified.",
				}),
			),
		}),
	},
	{
		name: "read",
		description:
			"Read the contents of a file. Output is limited to 2000 lines by default. Use offset and limit parameters to read specific sections of large files.",
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file, relative to repository root",
			}),
			offset: Type.Optional(
				Type.Number({
					description: "Line number to start reading from (1-indexed). Default: 1",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of lines to read. Default: 2000",
				}),
			),
		}),
	},
];

async function runCommand(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		return `Error (exit ${exitCode}):\n${stderr}`;
	}
	return stdout || "(no output)";
}

async function executeRg(args: Record<string, unknown>, repoPath: string): Promise<string> {
	const pattern = args.pattern as string;
	const glob = args.glob as string | undefined;
	const maxCount = (args.max_count as number | undefined) ?? RG_MAX_MATCHES_PER_FILE;
	const maxResults = args.max_results as number | undefined;
	const word = args.word as boolean | undefined;

	const cmd = ["rg", "--line-number", "--max-count", String(maxCount), pattern];
	if (glob) cmd.push("--glob", glob);
	if (word) cmd.push("-w");

	if (maxResults) {
		// Use head to limit total results
		const rgProc = Bun.spawn(cmd, {
			cwd: repoPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const headProc = Bun.spawn(["head", "-n", String(maxResults)], {
			stdin: rgProc.stdout,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(headProc.stdout).text(),
			new Response(rgProc.stderr).text(),
		]);
		await rgProc.exited;
		const exitCode = await headProc.exited;
		// rg returns 1 when no matches found, which is not an error
		if (exitCode !== 0 && stderr.trim()) {
			return `Error:\n${stderr}`;
		}
		return stdout || "(no matches)";
	}

	return runCommand(cmd, repoPath);
}

async function executeFd(args: Record<string, unknown>, repoPath: string): Promise<string> {
	const pattern = args.pattern as string;
	const type = args.type as "f" | "d" | "l" | "x" | undefined;
	const extension = args.extension as string | undefined;
	const maxDepth = args.max_depth as number | undefined;
	const maxResults = args.max_results as number | undefined;
	const hidden = args.hidden as boolean | undefined;
	const glob = args.glob as boolean | undefined;
	const exclude = args.exclude as string | undefined;
	const fullPath = args.full_path as boolean | undefined;

	const cmd = ["fd"];

	// Add flags before pattern
	if (type) cmd.push("--type", type);
	if (hidden) cmd.push("--hidden");
	if (glob) cmd.push("--glob");
	if (fullPath) cmd.push("--full-path");
	if (maxDepth !== undefined) cmd.push("--max-depth", String(maxDepth));
	if (maxResults !== undefined) cmd.push("--max-results", String(maxResults));
	if (exclude) cmd.push("--exclude", exclude);

	// Handle multiple extensions (comma-separated)
	if (extension) {
		for (const ext of extension.split(",").map((e) => e.trim())) {
			cmd.push("--extension", ext);
		}
	}

	// Add pattern
	cmd.push(pattern);

	return runCommand(cmd, repoPath);
}

async function executeLs(args: Record<string, unknown>, repoPath: string): Promise<string> {
	const path = (args.path as string | undefined) || ".";
	return runCommand(["ls", "-la", path], repoPath);
}

async function executeRead(args: Record<string, unknown>, repoPath: string): Promise<string> {
	const filePath = args.path as string;
	const offset = (args.offset as number | undefined) ?? 1;
	const limit = (args.limit as number | undefined) ?? DEFAULT_READ_LINE_LIMIT;
	const fullPath = join(repoPath, filePath);

	try {
		const content = await readFile(fullPath, "utf-8");
		const lines = content.split("\n");
		const totalLines = lines.length;

		// Convert to 0-indexed for slicing
		const startIdx = Math.max(0, offset - 1);
		const endIdx = startIdx + limit;
		const selectedLines = lines.slice(startIdx, endIdx);

		let result = selectedLines.join("\n");

		// Add metadata if file is truncated or offset is used
		if (totalLines > limit || offset > 1) {
			const displayEnd = Math.min(offset + selectedLines.length - 1, totalLines);
			result = `[Lines ${offset}-${displayEnd} of ${totalLines} total]\n\n${result}`;

			if (endIdx < totalLines) {
				const remaining = totalLines - endIdx;
				result += `\n\n[${remaining} more lines. Use offset=${endIdx + 1} to continue reading]`;
			}
		}

		return result;
	} catch (e) {
		return `Error reading file: ${(e as Error).message}`;
	}
}

export async function executeTool(toolName: string, args: Record<string, unknown>, repoPath: string): Promise<string> {
	switch (toolName) {
		case "rg":
			return executeRg(args, repoPath);
		case "fd":
			return executeFd(args, repoPath);
		case "ls":
			return executeLs(args, repoPath);
		case "read":
			return executeRead(args, repoPath);
		default:
			return `Unknown tool: ${toolName}`;
	}
}
