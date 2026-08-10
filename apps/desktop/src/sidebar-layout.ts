export const DEFAULT_SIDEBAR_WIDTH = 232;
export const MIN_SIDEBAR_WIDTH = 176;
export const MAX_SIDEBAR_WIDTH = 480;

const WIDTH_KEY = "ccsm.sidebar.width";
const COLLAPSED_KEY = "ccsm.sidebar.collapsed";

type SidebarStorage = Pick<Storage, "getItem" | "setItem">;

export function normalizeSidebarWidth(value: unknown): number {
  if (value === null || value === undefined || value === "")
    return DEFAULT_SIDEBAR_WIDTH;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.round(
    Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, numeric)),
  );
}

export function resizeSidebarWidth(startWidth: number, deltaX: number): number {
  return normalizeSidebarWidth(startWidth + deltaX);
}

export class SidebarLayoutController {
  readonly #resizer: HTMLElement;
  readonly #toggle: HTMLButtonElement;
  #width: number;
  #collapsed: boolean;

  constructor(
    private readonly root: HTMLElement,
    private readonly storage: SidebarStorage,
  ) {
    this.#resizer = required(root, "#sidebar-resizer");
    this.#toggle = required(root, "#sidebar-toggle");
    this.#width = normalizeSidebarWidth(storage.getItem(WIDTH_KEY));
    this.#collapsed = storage.getItem(COLLAPSED_KEY) === "true";
    this.#toggle.addEventListener("click", () => this.toggle());
    this.#resizer.addEventListener("pointerdown", (event) =>
      this.#beginResize(event),
    );
    this.#resizer.addEventListener("dblclick", () => {
      if (this.#collapsed) return;
      this.#setWidth(DEFAULT_SIDEBAR_WIDTH, true);
    });
    this.#resizer.addEventListener("keydown", (event) => {
      if (this.#collapsed) return;
      const delta = event.shiftKey ? 32 : 8;
      if (event.key === "ArrowLeft") this.#setWidth(this.#width - delta, true);
      else if (event.key === "ArrowRight")
        this.#setWidth(this.#width + delta, true);
      else if (event.key === "Home") this.#setWidth(MIN_SIDEBAR_WIDTH, true);
      else if (event.key === "End") this.#setWidth(MAX_SIDEBAR_WIDTH, true);
      else return;
      event.preventDefault();
    });
    this.#apply();
  }

  toggle(): void {
    this.#collapsed = !this.#collapsed;
    this.storage.setItem(COLLAPSED_KEY, String(this.#collapsed));
    this.#apply();
  }

  #beginResize(event: PointerEvent): void {
    if (this.#collapsed || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.#width;
    this.root.dataset.sidebarResizing = "true";
    this.#resizer.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      this.#setWidth(
        resizeSidebarWidth(startWidth, moveEvent.clientX - startX),
        false,
      );
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      delete this.root.dataset.sidebarResizing;
      this.storage.setItem(WIDTH_KEY, String(this.#width));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  }

  #setWidth(width: number, persist: boolean): void {
    this.#width = normalizeSidebarWidth(width);
    if (persist) this.storage.setItem(WIDTH_KEY, String(this.#width));
    this.#apply();
  }

  #apply(): void {
    this.root.style.setProperty("--sidebar-width", `${this.#width}px`);
    this.root.dataset.sidebarCollapsed = String(this.#collapsed);
    this.#toggle.setAttribute("aria-expanded", String(!this.#collapsed));
    this.#toggle.setAttribute(
      "aria-label",
      this.#collapsed ? "Expand sidebar" : "Collapse sidebar",
    );
    this.#toggle.title = this.#toggle.getAttribute("aria-label") ?? "Sidebar";
    this.#resizer.tabIndex = this.#collapsed ? -1 : 0;
    this.#resizer.setAttribute("aria-disabled", String(this.#collapsed));
    this.#resizer.setAttribute("aria-valuemin", String(MIN_SIDEBAR_WIDTH));
    this.#resizer.setAttribute("aria-valuemax", String(MAX_SIDEBAR_WIDTH));
    this.#resizer.setAttribute("aria-valuenow", String(this.#width));
  }
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing sidebar element: ${selector}`);
  return element;
}
