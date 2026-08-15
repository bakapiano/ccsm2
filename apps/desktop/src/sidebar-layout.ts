export const DEFAULT_SIDEBAR_WIDTH = 232;
export const MIN_SIDEBAR_WIDTH = 176;
export const MAX_SIDEBAR_WIDTH = 480;
export const DEFAULT_AGENTS_HEIGHT = 280;
export const MIN_AGENTS_HEIGHT = 112;
export const MIN_SPACE_TREE_HEIGHT = 96;

const SIDEBAR_FIXED_HEIGHT = 32 + 5;

const WIDTH_KEY = "ccsm.sidebar.width";
const AGENTS_HEIGHT_KEY = "ccsm.sidebar.agentsHeight";

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

export function maxAgentsHeight(sidebarHeight: number): number {
  return Math.max(
    MIN_AGENTS_HEIGHT,
    Math.round(sidebarHeight - SIDEBAR_FIXED_HEIGHT - MIN_SPACE_TREE_HEIGHT),
  );
}

export function normalizeAgentsHeight(
  value: unknown,
  sidebarHeight: number,
): number {
  const maximum = maxAgentsHeight(sidebarHeight);
  if (value === null || value === undefined || value === "")
    return Math.min(DEFAULT_AGENTS_HEIGHT, maximum);
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric))
    return Math.min(DEFAULT_AGENTS_HEIGHT, maximum);
  return Math.round(Math.min(maximum, Math.max(MIN_AGENTS_HEIGHT, numeric)));
}

export function normalizeAgentsPreferredHeight(value: unknown): number {
  if (value === null || value === undefined || value === "")
    return DEFAULT_AGENTS_HEIGHT;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AGENTS_HEIGHT;
  return Math.round(Math.max(MIN_AGENTS_HEIGHT, numeric));
}

export function resizeAgentsHeight(
  startHeight: number,
  deltaY: number,
  sidebarHeight: number,
): number {
  return normalizeAgentsHeight(startHeight - deltaY, sidebarHeight);
}

export class SidebarLayoutController {
  readonly #resizer: HTMLElement;
  readonly #agentsResizer: HTMLElement;
  #width: number;
  #agentsHeight: number;
  #agentsPreferredHeight: number;

  constructor(
    private readonly root: HTMLElement,
    private readonly storage: SidebarStorage,
  ) {
    this.#resizer = required(root, "#sidebar-resizer");
    this.#agentsResizer = required(root, "#agents-resizer");
    this.#width = normalizeSidebarWidth(storage.getItem(WIDTH_KEY));
    this.#agentsPreferredHeight = normalizeAgentsPreferredHeight(
      storage.getItem(AGENTS_HEIGHT_KEY),
    );
    this.#agentsHeight = normalizeAgentsHeight(
      this.#agentsPreferredHeight,
      this.#layoutHeight(),
    );
    this.#resizer.addEventListener("pointerdown", (event) =>
      this.#beginResize(event),
    );
    this.#agentsResizer.addEventListener("pointerdown", (event) =>
      this.#beginAgentsResize(event),
    );
    this.#resizer.addEventListener("dblclick", () => {
      this.#setWidth(DEFAULT_SIDEBAR_WIDTH, true);
    });
    this.#resizer.addEventListener("keydown", (event) => {
      const delta = event.shiftKey ? 32 : 8;
      if (event.key === "ArrowLeft") this.#setWidth(this.#width - delta, true);
      else if (event.key === "ArrowRight")
        this.#setWidth(this.#width + delta, true);
      else if (event.key === "Home") this.#setWidth(MIN_SIDEBAR_WIDTH, true);
      else if (event.key === "End") this.#setWidth(MAX_SIDEBAR_WIDTH, true);
      else return;
      event.preventDefault();
    });
    this.#agentsResizer.addEventListener("dblclick", () => {
      this.#setAgentsHeight(DEFAULT_AGENTS_HEIGHT, true);
    });
    this.#agentsResizer.addEventListener("keydown", (event) => {
      const delta = event.shiftKey ? 32 : 8;
      if (event.key === "ArrowUp")
        this.#setAgentsHeight(this.#agentsHeight + delta, true);
      else if (event.key === "ArrowDown")
        this.#setAgentsHeight(this.#agentsHeight - delta, true);
      else if (event.key === "Home")
        this.#setAgentsHeight(MIN_AGENTS_HEIGHT, true);
      else if (event.key === "End")
        this.#setAgentsHeight(maxAgentsHeight(this.#layoutHeight()), true);
      else return;
      event.preventDefault();
    });
    window.addEventListener("resize", () => {
      this.#agentsHeight = normalizeAgentsHeight(
        this.#agentsPreferredHeight,
        this.#layoutHeight(),
      );
      this.#apply();
    });
    this.#apply();
  }

  #beginResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.#width;
    this.root.dataset.sidebarResizing = "true";
    this.#resizer.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      this.#setWidth(
        resizeSidebarWidth(startWidth, moveEvent.clientX - startX),
        true,
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

  #beginAgentsResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.#agentsHeight;
    this.root.dataset.agentsResizing = "true";
    this.#agentsResizer.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      this.#setAgentsHeight(
        resizeAgentsHeight(
          startHeight,
          moveEvent.clientY - startY,
          this.#layoutHeight(),
        ),
        true,
      );
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      delete this.root.dataset.agentsResizing;
      this.storage.setItem(
        AGENTS_HEIGHT_KEY,
        String(this.#agentsPreferredHeight),
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  }

  #setAgentsHeight(height: number, persist: boolean): void {
    this.#agentsPreferredHeight = normalizeAgentsPreferredHeight(height);
    this.#agentsHeight = normalizeAgentsHeight(
      this.#agentsPreferredHeight,
      this.#layoutHeight(),
    );
    if (persist)
      this.storage.setItem(
        AGENTS_HEIGHT_KEY,
        String(this.#agentsPreferredHeight),
      );
    this.#apply();
  }

  #layoutHeight(): number {
    return this.root.getBoundingClientRect().height || window.innerHeight;
  }

  #apply(): void {
    this.root.style.setProperty("--sidebar-width", `${this.#width}px`);
    this.root.style.setProperty("--agents-height", `${this.#agentsHeight}px`);
    this.#resizer.tabIndex = 0;
    this.#resizer.setAttribute("aria-disabled", "false");
    this.#resizer.setAttribute("aria-valuemin", String(MIN_SIDEBAR_WIDTH));
    this.#resizer.setAttribute("aria-valuemax", String(MAX_SIDEBAR_WIDTH));
    this.#resizer.setAttribute("aria-valuenow", String(this.#width));
    this.#agentsResizer.tabIndex = 0;
    this.#agentsResizer.setAttribute("aria-disabled", "false");
    this.#agentsResizer.setAttribute(
      "aria-valuemin",
      String(MIN_AGENTS_HEIGHT),
    );
    this.#agentsResizer.setAttribute(
      "aria-valuemax",
      String(maxAgentsHeight(this.#layoutHeight())),
    );
    this.#agentsResizer.setAttribute(
      "aria-valuenow",
      String(this.#agentsHeight),
    );
  }
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing sidebar element: ${selector}`);
  return element;
}
