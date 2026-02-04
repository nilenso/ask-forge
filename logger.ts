export interface Logger {
	log(label: string, content: string): void;
	error(label: string, error: unknown): void;
}

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

export const nullLogger: Logger = {
	log() {},
	error() {},
};
