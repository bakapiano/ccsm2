export class SurfaceOcclusionController {
  readonly #reasons = new Set<string>();
  #applied = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly apply: (occluded: boolean) => Promise<void>) {}

  async set(reason: string, active: boolean): Promise<void> {
    if (active) this.#reasons.add(reason);
    else this.#reasons.delete(reason);
    const operation = this.#tail.then(async () => {
      const desired = this.#reasons.size > 0;
      if (desired === this.#applied) return;
      await this.apply(desired);
      this.#applied = desired;
    });
    this.#tail = operation.catch(() => {});
    await operation;
  }

  get occluded(): boolean {
    return this.#reasons.size > 0;
  }

  isActive(reason: string): boolean {
    return this.#reasons.has(reason);
  }
}
