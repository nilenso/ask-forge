import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdownLinks, validateLinks } from "../src/response-validation";

// =============================================================================
// parseMarkdownLinks
// =============================================================================

describe("parseMarkdownLinks", () => {
	test("extracts repo path from blob link", () => {
		const links = parseMarkdownLinks("[file](https://github.com/org/repo/blob/abc123/src/foo.ts)");
		expect(links).toHaveLength(1);
		expect(links[0]!.repoPath).toBe("src/foo.ts");
		expect(links[0]!.url).toBe("https://github.com/org/repo/blob/abc123/src/foo.ts");
	});

	test("extracts repo path from tree link", () => {
		const links = parseMarkdownLinks("[dir](https://github.com/org/repo/tree/abc123/src/utils)");
		expect(links).toHaveLength(1);
		expect(links[0]!.repoPath).toBe("src/utils");
	});

	test("strips line anchor from blob link", () => {
		const links = parseMarkdownLinks("[file](https://github.com/org/repo/blob/abc123/src/foo.ts#L42)");
		expect(links).toHaveLength(1);
		expect(links[0]!.repoPath).toBe("src/foo.ts");
	});

	test("strips line range anchor from blob link", () => {
		const links = parseMarkdownLinks("[file](https://github.com/org/repo/blob/abc123/src/foo.ts#L42-L55)");
		expect(links).toHaveLength(1);
		expect(links[0]!.repoPath).toBe("src/foo.ts");
	});

	test("returns null repoPath for non-repo links", () => {
		const links = parseMarkdownLinks("[docs](https://example.com/page)");
		expect(links).toHaveLength(1);
		expect(links[0]!.repoPath).toBeNull();
	});

	test("returns null repoPath for relative paths", () => {
		const links = parseMarkdownLinks("[file](src/foo.ts)");
		expect(links).toHaveLength(1);
		expect(links[0]!.repoPath).toBeNull();
	});

	test("parses multiple links in one response", () => {
		const text = [
			"See [foo](https://github.com/org/repo/blob/abc123/src/foo.ts)",
			"and [bar](https://github.com/org/repo/blob/abc123/src/bar.ts)",
			"and [docs](https://example.com/page)",
		].join("\n");
		const links = parseMarkdownLinks(text);
		expect(links).toHaveLength(3);
		expect(links[0]!.repoPath).toBe("src/foo.ts");
		expect(links[1]!.repoPath).toBe("src/bar.ts");
		expect(links[2]!.repoPath).toBeNull();
	});

	test("returns empty array when no links present", () => {
		expect(parseMarkdownLinks("no links here")).toEqual([]);
	});

	test("extracts repo path from GitLab blob link", () => {
		const links = parseMarkdownLinks("[file](https://gitlab.com/group/repo/-/blob/abc123/src/foo.ts)");
		expect(links).toHaveLength(1);
		expect(links[0]!.repoPath).toBe("src/foo.ts");
	});
});

// =============================================================================
// validateLinks
// =============================================================================

describe("validateLinks", () => {
	// Create a temp directory with known files for filesystem checks
	const repoDir = mkdtempSync(join(tmpdir(), "validate-links-test-"));
	mkdirSync(join(repoDir, "src"), { recursive: true });
	writeFileSync(join(repoDir, "src/foo.ts"), "");
	writeFileSync(join(repoDir, "README.md"), "");

	test("existing file is not broken", () => {
		const text = "[foo](https://github.com/org/repo/blob/abc123/src/foo.ts)";
		const result = validateLinks(text, repoDir);
		expect(result.totalRepoLinks).toBe(1);
		expect(result.broken).toHaveLength(0);
	});

	test("nonexistent file is broken", () => {
		const text = "[missing](https://github.com/org/repo/blob/abc123/src/nope.ts)";
		const result = validateLinks(text, repoDir);
		expect(result.totalRepoLinks).toBe(1);
		expect(result.broken).toHaveLength(1);
		expect(result.broken[0]!.repoPath).toBe("src/nope.ts");
	});

	test("separates valid and broken links", () => {
		const text = [
			"[exists](https://github.com/org/repo/blob/abc123/src/foo.ts)",
			"[missing](https://github.com/org/repo/blob/abc123/src/nope.ts)",
		].join("\n");
		const result = validateLinks(text, repoDir);
		expect(result.totalRepoLinks).toBe(2);
		expect(result.broken).toHaveLength(1);
		expect(result.broken[0]!.repoPath).toBe("src/nope.ts");
	});

	test("non-repo links are ignored", () => {
		const text = "[docs](https://example.com/page)";
		const result = validateLinks(text, repoDir);
		expect(result.totalRepoLinks).toBe(0);
		expect(result.broken).toHaveLength(0);
	});

	test("existing directory via tree link is not broken", () => {
		const text = "[src](https://github.com/org/repo/tree/abc123/src)";
		const result = validateLinks(text, repoDir);
		expect(result.totalRepoLinks).toBe(1);
		expect(result.broken).toHaveLength(0);
	});
});
