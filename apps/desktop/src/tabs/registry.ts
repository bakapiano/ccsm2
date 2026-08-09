import type { IContentRenderer } from "dockview";

import type { TabDto } from "../generated/TabDto";
import type { TabKind } from "../generated/TabKind";

export interface TabProvider {
  readonly kind: TabKind;
  createRenderer(tab: TabDto): IContentRenderer;
}

export class TabProviderRegistry {
  readonly #providers = new Map<TabKind, TabProvider>();

  register(provider: TabProvider): void {
    if (this.#providers.has(provider.kind)) {
      throw new Error(`duplicate TabProvider kind: ${provider.kind}`);
    }
    this.#providers.set(provider.kind, provider);
  }

  createRenderer(tab: TabDto): IContentRenderer {
    const provider = this.#providers.get(tab.kind);
    if (!provider) throw new Error(`no TabProvider registered for ${tab.kind}`);
    return provider.createRenderer(tab);
  }
}
