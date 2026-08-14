import type { TabDto } from "./generated/TabDto";

export const DOCKVIEW_DND_STRATEGY = "pointer" as const;
export const BROWSER_POPUP_DOCK_DIRECTION = "within" as const;

export function findSourceBrowserTab(
  tabs: Iterable<TabDto>,
  sourceSurfaceId: string,
): TabDto | undefined {
  return [...tabs].find(
    (tab) =>
      tab.kind === "browser" && (tab.resourceId ?? tab.id) === sourceSurfaceId,
  );
}

export function findDockPanelById<T extends { id: string }>(
  panels: readonly T[],
  panelId: string,
): T | undefined {
  return panels.find((panel) => panel.id === panelId);
}

export function syncDockPanelTitles<
  TPanel extends {
    id: string;
    title?: string;
    api: { setTitle(title: string): void };
  },
  TTab extends { title: string },
>(panels: readonly TPanel[], tabs: ReadonlyMap<string, TTab>): void {
  for (const panel of panels) {
    const tab = tabs.get(panel.id);
    if (tab && panel.title !== tab.title) panel.api.setTitle(tab.title);
  }
}

export function findNearestRightAlignedDockGroup<
  TGroup extends {
    id: string;
    isVisible?: boolean;
    element: {
      getBoundingClientRect(): Pick<DOMRect, "left" | "right" | "top">;
    };
  },
>(
  sourceGroup: TGroup,
  groups: readonly TGroup[],
  alignmentTolerance = 4,
): TGroup | undefined {
  const sourceRect = sourceGroup.element.getBoundingClientRect();
  return groups
    .filter((group) => group.id !== sourceGroup.id && group.isVisible !== false)
    .map((group) => ({
      group,
      rect: group.element.getBoundingClientRect(),
    }))
    .filter(
      ({ rect }) =>
        rect.left >= sourceRect.right - alignmentTolerance &&
        Math.abs(rect.top - sourceRect.top) <= alignmentTolerance,
    )
    .sort((left, right) => left.rect.left - right.rect.left)[0]?.group;
}

export function findVisibleDockPanelIds<
  TPanel extends { id: string },
  TGroup extends { activePanel?: TPanel; isVisible?: boolean },
>(groups: readonly TGroup[]): Set<string> {
  return new Set(
    groups.flatMap((group) =>
      group.isVisible !== false && group.activePanel
        ? [group.activePanel.id]
        : [],
    ),
  );
}

export function shouldDeleteRemovedTab<T>(
  restoringLayout: boolean,
  tab: T | undefined,
): tab is T {
  return !restoringLayout && tab !== undefined;
}

export function findRestoredActivePanel<
  TPanel extends { id: string },
  TGroup extends { id: string; activePanel?: TPanel },
>(
  panels: readonly TPanel[],
  groups: readonly TGroup[],
  activeTabId: string | null,
  focusedGroupId: string | null,
): TPanel | undefined {
  return (
    (activeTabId
      ? panels.find((panel) => panel.id === activeTabId)
      : undefined) ??
    (focusedGroupId
      ? groups.find((group) => group.id === focusedGroupId)?.activePanel
      : undefined)
  );
}
