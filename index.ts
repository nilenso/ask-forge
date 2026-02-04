import { getModel, type Message } from "@mariozechner/pi-ai";
import * as config from "./config";
import { type ConnectOptions, connectRepo, type Forge, type ForgeName, type Repo } from "./forge";
import {
	type AskOptions,
	type AskResult,
	type OnProgress,
	type ProgressEvent,
	Session,
	type ToolCallRecord,
} from "./session";
import { executeTool, tools } from "./tools";

// Re-export all public types
export type {
	AskOptions,
	AskResult,
	ConnectOptions,
	Forge,
	ForgeName,
	Message,
	OnProgress,
	ProgressEvent,
	Repo,
	Session,
	ToolCallRecord,
};

/**
 * Connect to a repository and create a session
 * @param repoUrl - The URL of the repository to connect to
 * @param options - Connection options (token, forge override, commitish)
 * @returns A Session for asking questions about the repository
 */
export async function connect(repoUrl: string, options: ConnectOptions = {}): Promise<Session> {
	const repo = await connectRepo(repoUrl, options);
	const model = getModel(config.MODEL_PROVIDER, config.MODEL_NAME);

	return new Session(repo, {
		model,
		systemPrompt: config.SYSTEM_PROMPT,
		tools,
		maxIterations: config.MAX_TOOL_ITERATIONS,
		executeTool,
	});
}
