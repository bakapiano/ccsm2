import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  BROWSER_POPUP_DOCK_DIRECTION,
  DOCKVIEW_DND_STRATEGY,
  findDockPanelById,
  findNearestRightAlignedDockGroup,
  findRestoredActivePanel,
  findSourceBrowserTab,
  findVisibleDockPanelIds,
  shouldDeleteRemovedTab,
  syncDockPanelTitles,
} from "./dock-behavior";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe("Dockview regressions", () => {
  test("selects the nearest top-aligned Dock to the right", () => {
    const group = (id: string, left: number, top: number, visible = true) => ({
      id,
      isVisible: visible,
      element: {
        getBoundingClientRect: () => ({ left, right: left + 300, top }),
      },
    });
    const source = group("source", 0, 100);
    const nearest = group("nearest", 300, 102);
    const farther = group("farther", 600, 100);
    const below = group("below", 300, 450);
    const hidden = group("hidden", 300, 100, false);

    expect(
      findNearestRightAlignedDockGroup(source, [
        farther,
        below,
        hidden,
        source,
        nearest,
      ])?.id,
    ).toBe("nearest");
    expect(findNearestRightAlignedDockGroup(source, [source, below])).toBe(
      undefined,
    );
  });

  test("uses pointer DnD for the embedded WebView host", async () => {
    const { DockviewComponent } = await import("dockview");
    const root = document.createElement("div");
    document.body.append(root);
    const dockview = new DockviewComponent(root, {
      createComponent: () => ({
        element: document.createElement("div"),
        init: () => {},
        dispose: () => {},
      }),
      dndStrategy: DOCKVIEW_DND_STRATEGY,
    });
    dockview.addPanel({ id: "source", component: "test" });

    const tab = root.querySelector<HTMLElement>(".dv-tab");
    expect(tab).not.toBeNull();
    expect(tab!.draggable).toBe(false);
    expect(dockview.options.dndStrategy).toBe("pointer");
    dockview.dispose();
    root.remove();
  });

  test("places a browser popup in its source tab list", async () => {
    const { DockviewComponent } = await import("dockview");
    const root = document.createElement("div");
    document.body.append(root);
    const dockview = new DockviewComponent(root, {
      createComponent: () => ({
        element: document.createElement("div"),
        init: () => {},
        dispose: () => {},
      }),
      dndStrategy: DOCKVIEW_DND_STRATEGY,
    });
    const source = dockview.addPanel({
      id: "browser-source",
      component: "test",
    });
    const resolvedSource = findDockPanelById(dockview.panels, source.id);
    expect(resolvedSource).toBe(source);
    const popup = dockview.addPanel({
      id: "browser-popup",
      component: "test",
      position: {
        referencePanel: resolvedSource!.id,
        direction: BROWSER_POPUP_DOCK_DIRECTION,
      },
    });

    expect(popup.group.id).toBe(source.group.id);
    dockview.dispose();
    root.remove();
  });

  test("resolves the popup source by native surface identity", () => {
    const source = {
      id: "tab-1",
      spaceId: "space-1",
      kind: "browser" as const,
      title: "Browser",
      resourceId: "surface-1",
      stateVersion: 1,
      state: {},
    };
    expect(findSourceBrowserTab([source], "surface-1")).toBe(source);
    expect(findSourceBrowserTab([source], "other")).toBeUndefined();
    expect(findDockPanelById([{ id: "tab-1" }], "tab-1")?.id).toBe("tab-1");
  });

  test("restores the persisted active Tab after Dockview deserialization", () => {
    const files = { id: "files" };
    const shell = { id: "shell" };
    const groups = [
      { id: "top", activePanel: files },
      { id: "bottom", activePanel: shell },
    ];

    expect(
      findRestoredActivePanel([files, shell], groups, "files", "top"),
    ).toBe(files);
    expect(
      findRestoredActivePanel([files, shell], groups, null, "bottom"),
    ).toBe(shell);
  });

  test("refreshes serialized panel titles from authoritative Tabs", () => {
    const applied: string[] = [];
    const panels = [
      {
        id: "changes",
        title: "Git",
        api: { setTitle: (title: string) => applied.push(title) },
      },
      {
        id: "files",
        title: "Files",
        api: { setTitle: (title: string) => applied.push(title) },
      },
    ];

    syncDockPanelTitles(
      panels,
      new Map([
        ["changes", { title: "Changes" }],
        ["files", { title: "Files" }],
      ]),
    );

    expect(applied).toEqual(["Changes"]);
  });

  test("tracks the active visible panel in every split group", () => {
    const codex = { id: "codex" };
    const claude = { id: "claude" };
    const hidden = { id: "hidden" };

    expect([
      ...findVisibleDockPanelIds([
        { activePanel: codex, isVisible: true },
        { activePanel: claude, isVisible: true },
        { activePanel: hidden, isVisible: false },
        { activePanel: undefined, isVisible: true },
      ]),
    ]).toEqual(["codex", "claude"]);
    expect([...findVisibleDockPanelIds([{ activePanel: undefined }])]).toEqual(
      [],
    );
  });

  test("deletes user-closed Tabs and ignores internal layout teardown", () => {
    const tab = { id: "codex" };
    expect(shouldDeleteRemovedTab(false, tab)).toBe(true);
    expect(shouldDeleteRemovedTab(true, tab)).toBe(false);
    expect(shouldDeleteRemovedTab(false, undefined)).toBe(false);
  });
});
