import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupWorktree, connectRepo } from "./forge";

// =============================================================================
// Test Helpers
// =============================================================================

interface TestRepo {
	/** file:// URL to the bare repo */
	url: string;
	/** Path to the bare repo */
	barePath: string;
	/** SHA of each commit (index 0 = first commit) */
	commits: string[];
	/** Tag names created */
	tags: string[];
}

/** Run a git command and return stdout */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			// Prevent git from prompting
			GIT_TERMINAL_PROMPT: "0",
			// Set committer info for test commits
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
		},
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout.trim();
}

/**
 * Create a test git repository with commits and tags.
 * Returns a file:// URL that can be used with connectRepo.
 *
 * The repo is structured as user/repo to match expected URL parsing.
 */
async function createTestRepo(baseDir: string): Promise<TestRepo> {
	// Structure as user/repo.git to match expected URL format
	const barePath = join(baseDir, "testuser", "testrepo.git");
	const workPath = join(baseDir, "work");

	await mkdir(join(baseDir, "testuser"), { recursive: true });

	// Create bare repo (acts as remote)
	await mkdir(barePath, { recursive: true });
	await git(barePath, "init", "--bare");

	// Clone to working directory
	await git(baseDir, "clone", barePath, "work");

	const commits: string[] = [];
	const tags: string[] = [];

	// Create first commit
	await Bun.write(join(workPath, "README.md"), "# Test Repo\n\nVersion 1");
	await git(workPath, "add", ".");
	await git(workPath, "commit", "-m", "Initial commit");
	commits.push(await git(workPath, "rev-parse", "HEAD"));

	// Create tag v1.0
	await git(workPath, "tag", "v1.0");
	tags.push("v1.0");

	// Create second commit
	await Bun.write(join(workPath, "README.md"), "# Test Repo\n\nVersion 2");
	await git(workPath, "add", ".");
	await git(workPath, "commit", "-m", "Second commit");
	commits.push(await git(workPath, "rev-parse", "HEAD"));

	// Create tag v2.0
	await git(workPath, "tag", "v2.0");
	tags.push("v2.0");

	// Push to bare repo (use HEAD to push current branch regardless of name)
	await git(workPath, "push", "origin", "HEAD", "--tags");

	return {
		url: `file://${barePath}`,
		barePath,
		commits,
		tags,
	};
}

// =============================================================================
// Test Suite
// =============================================================================

describe("forge", () => {
	let testDir: string;
	let testRepo: TestRepo;
	let originalHome: string | undefined;

	beforeEach(async () => {
		// Override HOME FIRST to isolate cache directory
		// This must happen before createTestRepo since connectRepo uses homedir()
		originalHome = process.env.HOME;
		testDir = join(tmpdir(), `ask-forge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
		process.env.HOME = testDir;

		// Create test repository
		testRepo = await createTestRepo(testDir);
	});

	afterEach(async () => {
		// Restore HOME
		if (originalHome) {
			process.env.HOME = originalHome;
		}

		// Clean up test directory
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("connectRepo", () => {
		test("clones repo and creates worktree", async () => {
			// Use forge: "github" for local file:// URLs (forge is required for non-github/gitlab URLs)
			const repo = await connectRepo(testRepo.url, { forge: "github" });

			expect(repo.url).toBe(testRepo.url);
			expect(repo.localPath).toContain(".ask-forge");
			expect(repo.commitish).toBe(testRepo.commits[1]); // HEAD = latest commit

			// Verify files are accessible
			const readme = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readme).toContain("Version 2");
		});

		test("checks out specific tag", async () => {
			const repo = await connectRepo(testRepo.url, { forge: "github", commitish: "v1.0" });

			expect(repo.commitish).toBe(testRepo.commits[0]);

			// Verify we have v1.0 content
			const readme = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readme).toContain("Version 1");
		});

		test("checks out specific SHA", async () => {
			const sha = testRepo.commits[0];
			const repo = await connectRepo(testRepo.url, { forge: "github", commitish: sha });

			expect(repo.commitish).toBe(sha);

			const readme = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readme).toContain("Version 1");
		});

		test("reuses cached bare repo for different commitish", async () => {
			const repo1 = await connectRepo(testRepo.url, { forge: "github", commitish: "v1.0" });
			const repo2 = await connectRepo(testRepo.url, { forge: "github", commitish: "v2.0" });

			// Same cache path (bare repo)
			expect(repo1.cachePath).toBe(repo2.cachePath);

			// Different worktree paths
			expect(repo1.localPath).not.toBe(repo2.localPath);

			// Both have correct content
			const readme1 = await readFile(join(repo1.localPath, "README.md"), "utf-8");
			const readme2 = await readFile(join(repo2.localPath, "README.md"), "utf-8");
			expect(readme1).toContain("Version 1");
			expect(readme2).toContain("Version 2");
		});

		test("parallel calls don't corrupt repo", async () => {
			// Connect 3 times in parallel
			const results = await Promise.all([
				connectRepo(testRepo.url, { forge: "github", commitish: "v1.0" }),
				connectRepo(testRepo.url, { forge: "github", commitish: "v1.0" }),
				connectRepo(testRepo.url, { forge: "github", commitish: "v1.0" }),
			]);

			// All should succeed with same commitish
			for (const repo of results) {
				expect(repo.commitish).toBe(testRepo.commits[0]);
				const readme = await readFile(join(repo.localPath, "README.md"), "utf-8");
				expect(readme).toContain("Version 1");
			}

			// All should share same cache and worktree (same commitish = same worktree)
			expect(results[0].cachePath).toBe(results[1].cachePath);
			expect(results[0].localPath).toBe(results[1].localPath);
		});

		test("throws for non-existent commitish", async () => {
			await expect(connectRepo(testRepo.url, { forge: "github", commitish: "nonexistent-branch" })).rejects.toThrow(
				"Failed to resolve commitish",
			);
		});

		test("throws for invalid URL", async () => {
			await expect(connectRepo("not-a-valid-url")).rejects.toThrow();
		});

		test("throws for unknown forge without explicit option", async () => {
			await expect(connectRepo("https://unknown-forge.com/user/repo")).rejects.toThrow("Cannot infer forge");
		});
	});

	describe("cleanupWorktree", () => {
		test("removes worktree successfully", async () => {
			const repo = await connectRepo(testRepo.url, { forge: "github" });

			// Worktree exists
			const readmeBefore = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readmeBefore).toBeDefined();

			// Clean up
			const success = await cleanupWorktree(repo);
			expect(success).toBe(true);

			// Worktree should be gone
			await expect(readFile(join(repo.localPath, "README.md"), "utf-8")).rejects.toThrow();
		});

		test("returns false for non-existent worktree", async () => {
			const repo = await connectRepo(testRepo.url, { forge: "github" });

			// Clean up twice
			await cleanupWorktree(repo);
			const success = await cleanupWorktree(repo);

			// Second cleanup should fail gracefully
			expect(success).toBe(false);
		});
	});
});
