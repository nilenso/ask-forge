import type { Message } from "@mariozechner/pi-ai";
import { type ConnectOptions, connectRepo, type Forge, type ForgeName, type Repo } from "./forge";
import {
	type AskOptions,
	type AskResult,
	createSession,
	type OnProgress,
	type ProgressEvent,
	type Session,
	type ToolCallRecord,
} from "./session";

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
	return createSession(repo);
}
