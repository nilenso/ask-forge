/**
 * Unit tests for sandbox worker HTTP request body validators.
 *
 * These exercise the pure validation layer directly — they don't require
 * the sandbox container to be running. Integration-level 400 responses
 * are covered in sandbox.integration.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { validateCloneRequest, validateToolRequest } from "../../src/sandbox/request-schemas";

describe("validateCloneRequest", () => {
	test("accepts minimal valid body (url only)", () => {
		const result = validateCloneRequest({ url: "https://github.com/octocat/Hello-World" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.url).toBe("https://github.com/octocat/Hello-World");
			expect(result.value.commitish).toBeUndefined();
		}
	});

	test("accepts optional commitish", () => {
		const result = validateCloneRequest({
			url: "https://github.com/octocat/Hello-World",
			commitish: "main",
		});
		expect(result.ok).toBe(true);
	});

	test("ignores extra fields (permissive additionalProperties)", () => {
		const result = validateCloneRequest({
			url: "https://github.com/octocat/Hello-World",
			weird_extra: 42,
		});
		expect(result.ok).toBe(true);
	});

	test("rejects missing url", () => {
		const result = validateCloneRequest({});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("url");
	});

	test("rejects non-string url", () => {
		const result = validateCloneRequest({ url: 123 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("url");
	});

	test("rejects empty url (minLength: 1)", () => {
		const result = validateCloneRequest({ url: "" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("url");
	});

	test("rejects empty commitish when provided", () => {
		const result = validateCloneRequest({
			url: "https://github.com/octocat/Hello-World",
			commitish: "",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("commitish");
	});

	test("rejects non-object payloads", () => {
		expect(validateCloneRequest(null).ok).toBe(false);
		expect(validateCloneRequest(undefined).ok).toBe(false);
		expect(validateCloneRequest("string").ok).toBe(false);
		expect(validateCloneRequest(42).ok).toBe(false);
		expect(validateCloneRequest([]).ok).toBe(false);
	});
});

describe("validateToolRequest", () => {
	const valid = {
		slug: "github.com/octocat/Hello-World",
		sha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
		name: "ls",
		args: {},
	};

	test("accepts a valid body", () => {
		const result = validateToolRequest(valid);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.name).toBe("ls");
			expect(result.value.args).toEqual({});
		}
	});

	test("accepts non-empty args object", () => {
		const result = validateToolRequest({ ...valid, name: "rg", args: { pattern: "Hello" } });
		expect(result.ok).toBe(true);
	});

	test("rejects missing slug", () => {
		const { slug: _slug, ...rest } = valid;
		const result = validateToolRequest(rest);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("slug");
	});

	test("rejects missing sha", () => {
		const { sha: _sha, ...rest } = valid;
		const result = validateToolRequest(rest);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("sha");
	});

	test("rejects missing name", () => {
		const { name: _name, ...rest } = valid;
		const result = validateToolRequest(rest);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("name");
	});

	test("rejects missing args", () => {
		const { args: _args, ...rest } = valid;
		const result = validateToolRequest(rest);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("args");
	});

	test("rejects empty string fields", () => {
		expect(validateToolRequest({ ...valid, slug: "" }).ok).toBe(false);
		expect(validateToolRequest({ ...valid, sha: "" }).ok).toBe(false);
		expect(validateToolRequest({ ...valid, name: "" }).ok).toBe(false);
	});

	test("rejects non-object args", () => {
		expect(validateToolRequest({ ...valid, args: null }).ok).toBe(false);
		expect(validateToolRequest({ ...valid, args: "string" }).ok).toBe(false);
		expect(validateToolRequest({ ...valid, args: 42 }).ok).toBe(false);
	});

	test("rejects wrong-typed top-level fields", () => {
		expect(validateToolRequest({ ...valid, slug: 123 }).ok).toBe(false);
		expect(validateToolRequest({ ...valid, sha: true }).ok).toBe(false);
		expect(validateToolRequest({ ...valid, name: [] }).ok).toBe(false);
	});

	test("error messages name the offending field", () => {
		const result = validateToolRequest({ ...valid, name: 42 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Format: "<message> at '<field>'"
			expect(result.error).toMatch(/at 'name'/);
		}
	});
});
