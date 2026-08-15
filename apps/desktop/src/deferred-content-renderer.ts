import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";

import type { FrameTaskScheduler } from "./frame-task-scheduler";

export class DeferredContentRenderer implements IContentRenderer {
  readonly element = document.createElement("div");
  #delegate: IContentRenderer | null = null;
  #parameters: GroupPanelPartInitParameters | null = null;
  #visible = false;
  #disposed = false;
  #focusRequested = false;
  #width = 0;
  #height = 0;

  constructor(
    private readonly id: string,
    private readonly create: () => IContentRenderer,
    private readonly scheduler: FrameTaskScheduler,
    private readonly materialized: (id: string) => void = () => {},
  ) {
    this.element.className = "deferred-tab-renderer";
    this.element.dataset.tabId = id;
    this.element.textContent = "Restoring Tab…";
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this.#parameters = parameters;
  }

  onShow(): void {
    this.#visible = true;
    if (this.#delegate) this.#delegate.onShow?.();
    else this.#schedule(this.#focusRequested);
  }

  onHide(): void {
    this.#visible = false;
    if (this.#delegate) this.#delegate.onHide?.();
    else this.scheduler.cancel(this.id);
  }

  layout(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
    this.#delegate?.layout?.(width, height);
  }

  focus(): void {
    if (this.#delegate) {
      this.#delegate.focus?.();
      return;
    }
    this.#focusRequested = true;
    this.#schedule(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.scheduler.cancel(this.id);
    this.#delegate?.dispose?.();
    this.#delegate = null;
    this.#parameters = null;
  }

  #schedule(priority: boolean): void {
    if (this.#disposed || this.#delegate || !this.#visible) return;
    this.scheduler.enqueue(this.id, () => this.#materialize(), priority);
  }

  #materialize(): void {
    const parameters = this.#parameters;
    if (this.#disposed || this.#delegate || !this.#visible || !parameters)
      return;
    try {
      const delegate = this.create();
      this.#delegate = delegate;
      this.element.replaceChildren(delegate.element);
      delegate.init(parameters);
      delegate.layout?.(this.#width, this.#height);
      delegate.onShow?.();
      if (this.#focusRequested) delegate.focus?.();
      this.materialized(this.id);
    } catch (error) {
      this.element.dataset.error = "true";
      this.element.textContent =
        error instanceof Error ? error.message : "Tab restore failed";
    }
  }
}
