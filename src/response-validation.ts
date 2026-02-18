import { accessSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface ParsedLink {
	/** Full markdown link text e.g. [text](url) */
	fullMatch: string;
	/** The URL portion */
	url: string;
	/** Repo-relative file path extracted from the URL, or null if not a blob/tree link */
	repoPath: string | null;
}

export interface LinkValidationResult {
	/** Total number of links pointing into the repo (blob/tree URLs) */
	totalRepoLinks: number;
	/** Links whose repo-relative paths do not exist on disk */
	broken: ParsedLink[];
}

// =============================================================================
// Link Validation
// =============================================================================

/**
 * Extract repo-relative paths from markdown links that point into a blob/tree URL.
 * Matches patterns like: /blob/{sha}/path/to/file.ts or /tree/{sha}/path/to/dir
 */
export function parseMarkdownLinks(text: string): ParsedLink[] {
	const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
	const results: ParsedLink[] = [];
	for (const match of text.matchAll(linkRegex)) {
		const url = match[2];
		if (!url) continue;
		// Match /blob/<sha>/path or /tree/<sha>/path, strip optional #fragment
		const blobMatch = url.match(/\/(?:blob|tree)\/[a-f0-9]+\/(.+?)(?:#.*)?$/);
		results.push({
			fullMatch: match[0],
			url,
			repoPath: blobMatch?.[1] ?? null,
		});
	}
	return results;
}

/**
 * Validate that all repo-relative paths in markdown links exist on disk.
 * Returns total repo link count and the list of broken links.
 */
export function validateLinks(responseText: string, repoLocalPath: string): LinkValidationResult {
	const links = parseMarkdownLinks(responseText);
	const repoLinks = links.filter((l): l is ParsedLink & { repoPath: string } => l.repoPath !== null);
	const broken: ParsedLink[] = [];
	for (const link of repoLinks) {
		try {
			accessSync(join(repoLocalPath, link.repoPath));
		} catch {
			broken.push(link);
		}
	}
	return { totalRepoLinks: repoLinks.length, broken };
}
