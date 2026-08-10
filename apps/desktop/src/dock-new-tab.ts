import type {
  DockviewGroupPanel,
  IGroupHeaderProps,
  IHeaderActionsRenderer,
} from "dockview";

export type OpenDockNewTabMenu = (
  group: DockviewGroupPanel,
  anchor: HTMLButtonElement,
) => void;

export class DockNewTabAction implements IHeaderActionsRenderer {
  readonly element = document.createElement("div");
  readonly #button = document.createElement("button");
  readonly #onClick: (event: MouseEvent) => void;

  constructor(group: DockviewGroupPanel, openMenu: OpenDockNewTabMenu) {
    this.element.className = "dock-new-tab-action";
    this.#button.className = "dock-new-tab-button";
    this.#button.type = "button";
    this.#button.title = "New Tab";
    this.#button.setAttribute("aria-label", "New Tab");
    this.#button.setAttribute("aria-haspopup", "menu");
    this.#button.setAttribute("aria-expanded", "false");
    this.#button.innerHTML = `
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3v10M3 8h10"></path>
      </svg>`;
    this.#onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu(group, this.#button);
    };
    this.#button.addEventListener("click", this.#onClick);
    this.element.append(this.#button);
  }

  init(_params: IGroupHeaderProps): void {}

  dispose(): void {
    this.#button.removeEventListener("click", this.#onClick);
  }
}

export function dockNewTabMenuPosition(
  anchor: Pick<DOMRect, "bottom" | "right">,
  menuWidth: number,
  viewportWidth: number,
): { left: number; top: number } {
  return {
    left: Math.max(
      8,
      Math.min(anchor.right - menuWidth, viewportWidth - menuWidth - 8),
    ),
    top: anchor.bottom + 4,
  };
}
