import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  COLLAPSED_SIDEBAR_WIDTH,
  DEFAULT_AGENTS_HEIGHT,
  DEFAULT_SIDEBAR_WIDTH,
  maxAgentsHeight,
  MIN_AGENTS_HEIGHT,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  normalizeAgentsHeight,
  normalizeAgentsPreferredHeight,
  normalizeSidebarCollapsed,
  normalizeSidebarWidth,
  resizeAgentsHeight,
  resizeSidebarWidth,
  SidebarLayoutController,
} from "./sidebar-layout";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe("resizable sidebar", () => {
  test("restores a bounded width from storage", () => {
    expect(normalizeSidebarWidth(null)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(normalizeSidebarWidth("320")).toBe(320);
    expect(normalizeSidebarWidth(20)).toBe(MIN_SIDEBAR_WIDTH);
    expect(normalizeSidebarWidth(2_000)).toBe(MAX_SIDEBAR_WIDTH);
  });

  test("applies pointer deltas without leaving supported bounds", () => {
    expect(resizeSidebarWidth(232, 40)).toBe(272);
    expect(resizeSidebarWidth(232, -500)).toBe(MIN_SIDEBAR_WIDTH);
    expect(resizeSidebarWidth(232, 500)).toBe(MAX_SIDEBAR_WIDTH);
  });

  test("normalizes the persisted collapsed state", () => {
    expect(normalizeSidebarCollapsed(null)).toBe(false);
    expect(normalizeSidebarCollapsed("false")).toBe(false);
    expect(normalizeSidebarCollapsed("true")).toBe(true);
    expect(normalizeSidebarCollapsed(true)).toBe(true);
  });

  test("resizes Agents while preserving a usable Space tree", () => {
    expect(maxAgentsHeight(900)).toBe(735);
    expect(normalizeAgentsHeight(null, 900)).toBe(DEFAULT_AGENTS_HEIGHT);
    expect(normalizeAgentsPreferredHeight("420")).toBe(420);
    expect(normalizeAgentsPreferredHeight(20)).toBe(MIN_AGENTS_HEIGHT);
    expect(normalizeAgentsHeight(20, 900)).toBe(MIN_AGENTS_HEIGHT);
    expect(normalizeAgentsHeight(2_000, 900)).toBe(735);
    expect(resizeAgentsHeight(280, -40, 900)).toBe(320);
    expect(resizeAgentsHeight(280, 500, 900)).toBe(MIN_AGENTS_HEIGHT);
  });

  test("restores the preferred Agents height after a temporary window shrink", () => {
    const storage = createMemoryStorage({
      "ccsm.sidebar.width": "318",
      "ccsm.sidebar.agentsHeight": "420",
    });
    const height = { value: 900 };
    const { root } = createController(storage, height);

    expect(root.style.getPropertyValue("--sidebar-width")).toBe("318px");
    expect(root.style.getPropertyValue("--agents-height")).toBe("420px");

    height.value = 400;
    window.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--agents-height")).toBe("235px");

    height.value = 900;
    window.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--agents-height")).toBe("420px");
  });

  test("caches both drag sizes before pointer release", () => {
    const storage = createMemoryStorage();
    const height = { value: 900 };
    const { sidebarResizer, agentsResizer } = createController(storage, height);

    sidebarResizer.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 232,
        pointerId: 1,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 312, pointerId: 1 }),
    );
    expect(storage.values.get("ccsm.sidebar.width")).toBe("312");
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));

    agentsResizer.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientY: 500,
        pointerId: 2,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientY: 450, pointerId: 2 }),
    );
    expect(storage.values.get("ccsm.sidebar.agentsHeight")).toBe("330");
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2 }));
  });

  test("collapses to the compact rail and restores the expanded width", () => {
    const storage = createMemoryStorage({
      "ccsm.sidebar.width": "318",
    });
    const height = { value: 900 };
    const { root, sidebarResizer, agentsResizer, toggle } = createController(
      storage,
      height,
    );

    expect(root.style.getPropertyValue("--sidebar-width")).toBe("318px");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    toggle.click();

    expect(root.dataset.sidebarCollapsed).toBe("true");
    expect(root.style.getPropertyValue("--sidebar-width")).toBe(
      `${COLLAPSED_SIDEBAR_WIDTH}px`,
    );
    expect(storage.values.get("ccsm.sidebar.collapsed")).toBe("true");
    expect(storage.values.get("ccsm.sidebar.width")).toBe("318");
    expect(toggle.getAttribute("aria-label")).toBe("Expand sidebar");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(sidebarResizer.tabIndex).toBe(-1);
    expect(sidebarResizer.getAttribute("aria-disabled")).toBe("true");
    expect(agentsResizer.tabIndex).toBe(-1);

    toggle.click();

    expect(root.dataset.sidebarCollapsed).toBe("false");
    expect(root.style.getPropertyValue("--sidebar-width")).toBe("318px");
    expect(storage.values.get("ccsm.sidebar.collapsed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(sidebarResizer.tabIndex).toBe(0);
  });

  test("restores a collapsed sidebar from storage", () => {
    const storage = createMemoryStorage({
      "ccsm.sidebar.width": "360",
      "ccsm.sidebar.collapsed": "true",
    });
    const { root, toggle } = createController(storage, { value: 900 });

    expect(root.dataset.sidebarCollapsed).toBe("true");
    expect(root.style.getPropertyValue("--sidebar-width")).toBe(
      `${COLLAPSED_SIDEBAR_WIDTH}px`,
    );
    expect(toggle.getAttribute("aria-label")).toBe("Expand sidebar");
  });
});

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function createController(
  storage: ReturnType<typeof createMemoryStorage>,
  height: { value: number },
) {
  const root = document.createElement("div");
  root.innerHTML = `
    <div id="agents-resizer"></div>
    <div id="sidebar-resizer"></div>
    <button id="sidebar-toggle" type="button"></button>
  `;
  Object.defineProperty(root, "getBoundingClientRect", {
    value: () => ({
      bottom: height.value,
      height: height.value,
      left: 0,
      right: 900,
      top: 0,
      width: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  const sidebarResizer = root.querySelector<HTMLElement>("#sidebar-resizer")!;
  const agentsResizer = root.querySelector<HTMLElement>("#agents-resizer")!;
  const toggle = root.querySelector<HTMLButtonElement>("#sidebar-toggle")!;
  sidebarResizer.setPointerCapture = () => {};
  agentsResizer.setPointerCapture = () => {};
  new SidebarLayoutController(root, storage);
  return { root, sidebarResizer, agentsResizer, toggle };
}
