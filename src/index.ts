import { getModel, type KnownProvider, type Message, stream } from "@mariozechner/pi-ai";
import type { CompactionSettings } from "./config";
import { type ConnectOptions, connectRepo, type Forge, type ForgeName, type Repo } from "./forge";
import { consoleLogger, type Logger, nullLogger } from "./logger";
import { SandboxClient, type SandboxClientConfig } from "./sandbox/client";
import {
	type AskOptions,
	type AskResult,
	type OnProgress,
	type ProgressEvent,
	Session,
	type ToolCallRecord,
} from "./session";
import { executeTool, tools } from "./tools";

// Re-export all public types and loggers
export type {
	AskOptions,
	AskResult,
	CompactionSettings,
	ConnectOptions,
	Forge,
	ForgeName,
	KnownProvider,
	Logger,
	Message,
	OnProgress,
	ProgressEvent,
	Repo,
	SandboxClientConfig,
	Session,
	ToolCallRecord,
};
export { consoleLogger, nullLogger };

/**
 * Build the default system prompt, interpolating the repository's browse URL
 * so the model can emit clickable source links.
 *
 * @param repoUrl - e.g. "https://github.com/owner/repo"
 * @param commitSha - full or short SHA for a permalink-stable blob base
 */
function buildDefaultSystemPrompt(repoUrl: string, commitSha: string): string {
	// Normalise: strip trailing slash and .git suffix
	const base = repoUrl.replace(/\/+$/, "").replace(/\.git$/, "");
	const blobBase = `${base}/blob/${commitSha}`;

	return `You are a code analysis assistant. You have access to a repository cloned at the current working directory.
Use the available tools to explore the codebase and answer the user's question.

Tool usage guidelines:
- IMPORTANT: When you need to make multiple tool calls, issue them ALL in a single response. Do NOT make one tool call at a time. For example, if you need to read 3 files, call read 3 times in one response rather than reading one file, waiting, then reading the next.
- Similarly, if you need to search for multiple patterns or list multiple directories, batch all those calls together.
- The 'read' tool returns up to 2000 lines by default. If you see "[X more lines...]" at the end, use the offset parameter to read additional sections if needed.
- For large files, consider using 'rg' first to find relevant line numbers, then 'read' with offset/limit to get context around those lines.

Response guidelines:
- Be as concise as possible without sacrificing completeness.
- Use structured format: headings, bullet points, or numbered lists.
- CRITICAL: Every claim in your response MUST be grounded in evidence from the codebase. If you cannot point to a specific file, function, or line that supports a statement, do not make that statement. There should be zero unsupported claims.
- Every piece of evidence MUST be a clickable markdown link into the repository. Never mention a file path, function, or line number as plain text — always link it.
- Link specificity must match the claim:
  - Configuration value or constant → exact line: [\`SOME_CONST\`](${blobBase}/path/to/file.ts#L42)
  - Function / class behaviour → name anchor with line range: [\`functionName\`](${blobBase}/path/to/file.ts#L10-L35)
  - Architectural / structural claims → file link: [\`path/to/file.ts\`](${blobBase}/path/to/file.ts)
  - Directory-level claims → tree link: [\`src/utils/\`](${base}/tree/${commitSha}/src/utils)
- The blob base URL for this repository is: ${blobBase}
- CRITICAL: Use ONLY exact file paths as returned by tool results (rg, fd, ls, read). Never reconstruct, abbreviate, or guess a file path. Copy-paste the path directly from tool output.
- If you don't know the answer or cannot find supporting evidence in the codebase, say so explicitly. Never speculate or fabricate claims.`;
}

/** Base configuration fields */
interface ForgeConfigBase {
	/** System prompt that defines the assistant's behavior (has a sensible default) */
	systemPrompt?: string;
	/** Maximum number of tool-use iterations before stopping (default: 20) */
	maxIterations?: number;
	/**
	 * Optional sandbox configuration.
	 * If provided, repository cloning and tool execution happen in an isolated sandbox.
	 * If omitted, operations run locally.
	 */
	sandbox?: SandboxClientConfig;
	/**
	 * Optional context compaction settings.
	 * When context grows too large, older messages are summarized to stay within limits.
	 * If omitted, uses sensible defaults (enabled with 200K context window).
	 */
	compaction?: Partial<CompactionSettings>;
}

/**
 * Configuration for the ask-forge library.
 *
 * Provider and model must either both be specified or both omitted.
 * If omitted, defaults to openrouter with claude-sonnet-4.5.
 */
export type ForgeConfig = ForgeConfigBase &
	(
		| {
				/** Model provider (e.g., "openrouter", "anthropic", "google") */
				provider: KnownProvider;
				/** Model name (must be compatible with the provider) */
				model: string;
		  }
		| {
				provider?: undefined;
				model?: undefined;
		  }
	);

/**
 * Client for connecting to repositories and creating sessions.
 *
 * The client holds configuration (model, prompts, sandbox settings) and can create
 * multiple sessions to different repositories. When using sandbox mode, the sandbox
 * client is reused across all sessions for efficiency.
 *
 * @example
 * ```ts
 * const client = new AskForgeClient({
 *   provider: "openrouter",
 *   model: "anthropic/claude-sonnet-4.5",
 *   systemPrompt: "You are a code analysis assistant.",
 *   maxIterations: 20,
 * });
 *
 * const session1 = await client.connect("https://github.com/owner/repo1");
 * const session2 = await client.connect("https://github.com/owner/repo2");
 * ```
 */
/** Resolved configuration with all defaults applied */
interface ResolvedConfig {
	provider: KnownProvider;
	model: string;
	/** Custom system prompt override. When undefined, a default prompt with repo links is built at connect() time. */
	systemPrompt: string | undefined;
	maxIterations: number;
	sandbox?: SandboxClientConfig;
	compaction?: Partial<CompactionSettings>;
}

export class AskForgeClient {
	/** The configuration used by this client (with defaults applied) */
	readonly config: ResolvedConfig;

	readonly #logger: Logger;
	readonly #sandboxClient?: SandboxClient;

	/**
	 * Create a new AskForgeClient.
	 *
	 * @param config - Library configuration (defaults to openrouter with claude-sonnet-4.5)
	 * @param logger - Logger instance (defaults to consoleLogger)
	 */
	constructor(config: ForgeConfig = {}, logger: Logger = consoleLogger) {
		this.config = {
			provider: config.provider ?? "openrouter",
			model: config.model ?? "anthropic/claude-sonnet-4.5",
			systemPrompt: config.systemPrompt,
			maxIterations: config.maxIterations ?? 20,
			sandbox: config.sandbox,
			compaction: config.compaction,
		};
		this.#logger = logger;

		if (this.config.sandbox) {
			this.#sandboxClient = new SandboxClient(this.config.sandbox);
		}
	}

	/**
	 * Connect to a repository and create a session.
	 *
	 * @param repoUrl - The URL of the repository to connect to
	 * @param options - Git connection options (token, forge, commitish)
	 * @returns A Session for asking questions about the repository
	 */
	async connect(repoUrl: string, options: ConnectOptions = {}): Promise<Session> {
		const { config } = this;

		// getModel has strict generics tying provider to model IDs - cast for flexibility
		const model = (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(config.provider, config.model);

		if (this.#sandboxClient) {
			// Sandbox mode: clone and execute tools in isolated container
			const cloneResult = await this.#sandboxClient.clone(repoUrl, options.commitish);

			// Create a Repo-like object with sandbox metadata
			const repo: Repo = {
				url: repoUrl,
				localPath: cloneResult.worktree,
				forge: { name: "github", buildCloneUrl: (url) => url }, // Sandbox handles auth
				commitish: cloneResult.sha,
				cachePath: "", // Not applicable for sandbox
			};

			// Capture sandboxClient reference for the closure
			const sandboxClient = this.#sandboxClient;

			// Wrap sandbox executeTool to match the expected signature
			const sandboxExecuteTool = async (name: string, args: Record<string, unknown>, _cwd: string) => {
				return sandboxClient.executeTool(cloneResult.slug, cloneResult.sha, name, args);
			};

			const systemPrompt = config.systemPrompt ?? buildDefaultSystemPrompt(repoUrl, repo.commitish);

			return new Session(repo, {
				model,
				systemPrompt,
				tools,
				maxIterations: config.maxIterations,
				executeTool: sandboxExecuteTool,
				logger: this.#logger,
				stream,
				compaction: config.compaction,
			});
		}

		// Local mode: clone and execute tools on local filesystem
		const repo = await connectRepo(repoUrl, options);

		const systemPrompt = config.systemPrompt ?? buildDefaultSystemPrompt(repoUrl, repo.commitish);

		return new Session(repo, {
			model,
			systemPrompt,
			tools,
			maxIterations: config.maxIterations,
			executeTool,
			logger: this.#logger,
			stream,
			compaction: config.compaction,
		});
	}

	/**
	 * Reset the sandbox, deleting all cloned repositories.
	 * Only available when sandbox mode is enabled.
	 *
	 * @throws Error if sandbox mode is not enabled
	 */
	async resetSandbox(): Promise<void> {
		if (!this.#sandboxClient) {
			throw new Error("Sandbox mode is not enabled");
		}
		await this.#sandboxClient.reset();
	}
}
