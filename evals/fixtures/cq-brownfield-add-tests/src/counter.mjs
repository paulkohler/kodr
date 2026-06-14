export class Counter {
	#value = 0;

	increment() {
		this.#value++;
	}

	decrement() {
		this.#value--;
	}

	get value() {
		return this.#value;
	}

	reset() {
		this.#value = 0;
	}
}
