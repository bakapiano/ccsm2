import { describe, expect, test } from "bun:test";
import type {
  ContextMenuItemConfig,
  GetTabContextMenuItemsParams,
} from "dockview";

import type { CliSessionDto } from "./generated/CliSessionDto";
import type { TabDto } from "./generated/TabDto";
import {
  createTabContextMenuItems,
  TAB_CONTEXT_MENU_LABELS,
} from "./tab-context-menu";
import { resolveTabIconKind } from "./tab-header";

function tab(kind: TabDto["kind"], title: string, resourceId: string): TabDto {
  return {
    id: `${kind}-${resourceId}`,
    spaceId: "space-1",
    kind,
    title,
    resourceId,
    stateVersion: 1,
    state: {},
  };
}

function session(
  id: string,
  provider: CliSessionDto["provider"],
): CliSessionDto {
  return {
    id,
    spaceId: "space-1",
    provider,
    cwd: "D:\\work",
    nativeSessionId: null,
    nativeBindingState: provider === "shell" ? "not_applicable" : "pending",
    desiredState: "running",
    lastExitSummary: null,
  };
}

function menuFixture(ids: string[]) {
  const closed: string[] = [];
  const panels = ids.map((id) => ({
    id,
    api: { close: () => closed.push(id) },
  }));
  const group = { panels };
  const params = {
    panel: panels[1] ?? panels[0],
    group,
  } as unknown as GetTabContextMenuItemsParams;
  return { closed, panels, group, params };
}

function configuredItem(
  items: ReturnType<typeof createTabContextMenuItems>,
  index: number,
): ContextMenuItemConfig {
  return items[index] as ContextMenuItemConfig;
}

describe("CCSM Tab chrome", () => {
  test("resolves stable provider and built-in Tab icons", () => {
    const sessions = [
      session("shell-1", "shell"),
      session("claude-1", "claude"),
      session("codex-1", "codex"),
    ];

    expect(
      resolveTabIconKind(tab("cli-session", "Renamed", "shell-1"), sessions),
    ).toBe("shell");
    expect(
      resolveTabIconKind(tab("cli-session", "Renamed", "claude-1"), sessions),
    ).toBe("claude");
    expect(
      resolveTabIconKind(tab("cli-session", "Renamed", "codex-1"), sessions),
    ).toBe("codex");
    expect(
      resolveTabIconKind(tab("browser", "Browser", "browser-1"), sessions),
    ).toBe("browser");
    expect(
      resolveTabIconKind(tab("file-explorer", "Files", "files-1"), sessions),
    ).toBe("files");
    expect(resolveTabIconKind(tab("git", "Git", "git-1"), sessions)).toBe(
      "git",
    );
  });

  test("reproduces the original menu order and group-local actions", () => {
    const fixture = menuFixture(["left", "selected", "right-1", "right-2"]);
    let opened = 0;
    const items = createTabContextMenuItems(fixture.params, () => opened++);

    expect(opened).toBe(1);
    expect(
      items
        .filter((item) => item !== "separator")
        .map((item) => (item as ContextMenuItemConfig).label),
    ).toEqual([...TAB_CONTEXT_MENU_LABELS]);
    expect(items[3]).toBe("separator");
    expect(configuredItem(items, 1).disabled).toBe(false);
    expect(configuredItem(items, 2).disabled).toBe(false);

    configuredItem(items, 2).action?.();
    expect(fixture.closed).toEqual(["right-1", "right-2"]);
  });

  test("disables actions that have no target", () => {
    const fixture = menuFixture(["only"]);
    const items = createTabContextMenuItems(fixture.params, () => {});

    expect(configuredItem(items, 1).disabled).toBe(true);
    expect(configuredItem(items, 2).disabled).toBe(true);
  });
});
