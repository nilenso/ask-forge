import { setupSandbox } from "./setup-sandbox.ts";

const command = process.argv[2];

switch (command) {
	case "setup-sandbox":
		await setupSandbox(process.argv.slice(3));
		break;
	case undefined:
	case "--help":
	case "-h":
		console.log(`Usage: megasthenes <command>

Commands:
  setup-sandbox  Generate a docker-compose file for the sandbox server

Options:
  --help, -h     Show this help message`);
		break;
	default:
		console.error(`Unknown command: ${command}\nRun 'megasthenes --help' for usage.`);
		process.exit(1);
}
