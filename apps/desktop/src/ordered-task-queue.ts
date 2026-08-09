export class OrderedTaskQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue(
    task: () => Promise<void>,
    onError: (error: unknown) => void,
  ): Promise<void> {
    const operation = this.#tail.then(task);
    this.#tail = operation.catch(onError);
    return this.#tail;
  }
}
