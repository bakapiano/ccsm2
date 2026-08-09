export interface RetainedRenderer {
  destroy(): void;
}

export class RetainedRendererCache<T extends RetainedRenderer> {
  readonly #renderers = new Map<string, T>();

  getOrCreate(id: string, create: () => T): T {
    const existing = this.#renderers.get(id);
    if (existing) return existing;
    const renderer = create();
    this.#renderers.set(id, renderer);
    return renderer;
  }

  get(id: string): T | undefined {
    return this.#renderers.get(id);
  }

  release(ids: Iterable<string>): void {
    for (const id of ids) {
      const renderer = this.#renderers.get(id);
      if (!renderer) continue;
      this.#renderers.delete(id);
      renderer.destroy();
    }
  }

  destroyAll(): void {
    this.release([...this.#renderers.keys()]);
  }

  forEach(callback: (renderer: T) => void): void {
    for (const renderer of this.#renderers.values()) callback(renderer);
  }
}
