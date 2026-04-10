/**
 * AskStream implementation — the return type of ask().
 *
 * Wraps an async generator of StreamEvent objects and provides a .result()
 * method that reduces them into a TurnResult. The stream starts lazily
 * when consumed (iterated or .result() awaited).
 */

import { TurnResultBuilder } from "./turn-result-builder";
import type { AskStream, StreamEvent, TurnResult } from "./types";

export class AskStreamImpl implements AskStream {
	#producer: () => AsyncGenerator<StreamEvent>;
	#onComplete?: (result: TurnResult) => void;
	#generator: AsyncGenerator<StreamEvent> | null = null;
	#resultPromise: Promise<TurnResult> | null = null;
	#builder = new TurnResultBuilder();
	#done = false;

	constructor(producer: () => AsyncGenerator<StreamEvent>, onComplete?: (result: TurnResult) => void) {
		this.#producer = producer;
		this.#onComplete = onComplete;
	}

	#ensureStarted(): AsyncGenerator<StreamEvent> {
		if (!this.#generator) {
			this.#generator = this.#producer();
		}
		return this.#generator;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
		const gen = this.#ensureStarted();

		for await (const event of gen) {
			this.#builder.process(event);
			yield event;
		}

		this.#markDone();
	}

	result(): Promise<TurnResult> {
		if (this.#resultPromise) return this.#resultPromise;

		this.#resultPromise = this.#resolveResult();
		return this.#resultPromise;
	}

	#markDone(): void {
		if (this.#done) return;
		this.#done = true;
		const result = this.#builder.build();
		this.#onComplete?.(result);
		this.#onComplete = undefined;
	}

	async #resolveResult(): Promise<TurnResult> {
		if (this.#done) {
			return this.#builder.build();
		}

		// Drain the stream if not already iterated
		const gen = this.#ensureStarted();
		for await (const event of gen) {
			this.#builder.process(event);
		}
		this.#markDone();

		return this.#builder.build();
	}
}
