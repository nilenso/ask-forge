/**
 * Logger interface for Session output.
 * Implement this interface to customize logging behavior.
 *
 * Levels (from most to least severe):
 *   error → warn → info/log → debug
 */
export interface Logger {
	/** Log an error with details (maps to console.error) */
	error(label: string, error: unknown): void;
	/** Log a warning (maps to console.warn) */
	warn(label: string, content: string): void;
	/** Log an informational message (maps to console.log) */
	log(label: string, content: string): void;
	/** Log an informational message (maps to console.info, same level as log) */
	info(label: string, content: string): void;
	/** Log a debug/trace message (maps to console.debug) */
	debug(label: string, content: string): void;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		let msg = error.message;
		if (error.cause) msg += ` cause=${JSON.stringify(error.cause)}`;
		return msg;
	}
	return JSON.stringify(error);
}

/**
 * Default logger that writes to console with a `[LEVEL] label: content` format.
 */
export const consoleLogger: Logger = {
	error: (label, error) => console.error(`[ERROR] ${label}: ${formatError(error)}`),
	warn: (label, content) => console.warn(`[WARN] ${label}: ${content}`),
	log: (label, content) => console.log(`[LOG] ${label}: ${content}`),
	info: (label, content) => console.info(`[INFO] ${label}: ${content}`),
	debug: (label, content) => console.debug(`[DEBUG] ${label}: ${content}`),
};

/**
 * No-op logger that discards all output.
 * Useful for testing or when logging is not desired.
 */
export const nullLogger: Logger = {
	error() {},
	warn() {},
	log() {},
	info() {},
	debug() {},
};
