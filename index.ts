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

/** Configuration for the ask-forge library */
export interface ForgeConfig {
	/** Model provider (e.g., "openrouter", "anthropic") */
	provider: KnownProvider;
	/** Model name (e.g., "anthropic/claude-sonnet-4.5") */
	model: string;
	/** System prompt that defines the assistant's behavior */
	systemPrompt: string;
	/** Maximum number of tool-use iterations before stopping */
	maxIterations: number;
	/** 
	 * Optional sandbox configuration. 
	 * If provided, repository cloning and tool execution happen in an isolated sandbox.
	 * If omitted, operations run locally.
	 */
	sandbox?: SandboxClientConfig;
}

/**
 * Connect to a repository and create a session
 *
 * @param repoUrl - The URL of the repository to connect to
 * @param config - Library configuration (model, prompts, limits, sandbox)
 * @param options - Git connection options (token, forge, commitish)
 * @param logger - Logger instance (defaults to consoleLogger)
 * @returns A Session for asking questions about the repository
 */
export async function connect(
	repoUrl: string,
	config: ForgeConfig,
	options: ConnectOptions = {},
	logger: Logger = consoleLogger,
): Promise<Session> {
	// getModel has strict generics tying provider to model IDs - cast for flexibility
	const model = (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(config.provider, config.model);

	if (config.sandbox) {
		// Sandbox mode: clone and execute tools in isolated container
		const sandboxClient = new SandboxClient(config.sandbox);
		const cloneResult = await sandboxClient.clone(repoUrl, options.commitish);

		// Create a Repo-like object with sandbox metadata
		const repo: Repo = {
			url: repoUrl,
			localPath: cloneResult.worktree,
			forge: { name: "github", buildCloneUrl: (url) => url }, // Sandbox handles auth
			commitish: cloneResult.sha,
			cachePath: "", // Not applicable for sandbox
		};

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
			logger,
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
		logger,
		stream,
	});
}
