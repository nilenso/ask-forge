import { getModel, type KnownProvider, type Message, stream } from "@mariozechner/pi-ai";
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

/** Default system prompt for code analysis */
const DEFAULT_SYSTEM_PROMPT = `You are a code analysis assistant. You have access to a repository cloned at the current working directory.
Use the available tools to explore the codebase and answer the user's question.

Tool usage guidelines:
- IMPORTANT: When you need to make multiple tool calls, issue them ALL in a single response. Do NOT make one tool call at a time. For example, if you need to read 3 files, call read 3 times in one response rather than reading one file, waiting, then reading the next.
- Similarly, if you need to search for multiple patterns or list multiple directories, batch all those calls together.
- The 'read' tool returns up to 2000 lines by default. If you see "[X more lines...]" at the end, use the offset parameter to read additional sections if needed.
- For large files, consider using 'rg' first to find relevant line numbers, then 'read' with offset/limit to get context around those lines.

Response guidelines:
- Be as concise as possible without sacrificing completeness.
- Use structured format: headings, bullet points, or numbered lists.
- Any claims should be grounded in the codebase and must contain evidence to support them (e.g., file paths, functions, or line ranges)
- Call out when you don't know the answer. Don't speculate.`;

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
	systemPrompt: string;
	maxIterations: number;
	sandbox?: SandboxClientConfig;
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
			systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
			maxIterations: config.maxIterations ?? 20,
			sandbox: config.sandbox,
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

			return new Session(repo, {
				model,
				systemPrompt: config.systemPrompt,
				tools,
				maxIterations: config.maxIterations,
				executeTool: sandboxExecuteTool,
				logger: this.#logger,
				stream,
			});
		}

		// Local mode: clone and execute tools on local filesystem
		const repo = await connectRepo(repoUrl, options);

		return new Session(repo, {
			model,
			systemPrompt: config.systemPrompt,
			tools,
			maxIterations: config.maxIterations,
			executeTool,
			logger: this.#logger,
			stream,
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

