/**
 * Logger interface for Session output.
 * Implement this interface to customize logging behavior.
 */
export interface Logger {
	/** Log an informational message */
	log(label: string, content: string): void;
	/** Log an error with details */
	error(label: string, error: unknown): void;
}

/**
 * Default logger that writes formatted output to console.
 * Uses box-drawing characters for visual separation.
 */
export const consoleLogger: Logger = {
	log(label: string, content: string) {
		console.log(`\n${"─".repeat(60)}`);
		console.log(`│ ${label}`);
		console.log(`${"─".repeat(60)}`);
		console.log(content);
	},

	error(label: string, error: unknown) {
		console.error(`\n${"═".repeat(60)}`);
		console.error(`│ ERROR: ${label}`);
		console.error(`${"═".repeat(60)}`);
		if (error instanceof Error) {
			console.error(`Message: ${error.message}`);
			if (error.cause) console.error(`Cause: ${JSON.stringify(error.cause, null, 2)}`);
			if (error.stack) console.error(`Stack: ${error.stack}`);
		} else {
			console.error(JSON.stringify(error, null, 2));
		}
		console.error(`${"═".repeat(60)}\n`);
	},
};

/**
 * No-op logger that discards all output.
 * Useful for testing or when logging is not desired.
 */
export const nullLogger: Logger = {
	log() {},
	error() {},
};
