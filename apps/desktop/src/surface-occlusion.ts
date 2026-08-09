export class SurfaceOcclusionController {
  readonly #reasons = new Set<string>();
  #occluded = false;

  constructor(private readonly apply: (occluded: boolean) => Promise<void>) {}

  async set(reason: string, active: boolean): Promise<void> {
    if (active) this.#reasons.add(reason);
    else this.#reasons.delete(reason);
    const occluded = this.#reasons.size > 0;
    if (occluded === this.#occluded) return;
    this.#occluded = occluded;
    await this.apply(occluded);
  }

  get occluded(): boolean {
    return this.#occluded;
  }
}
