import type { ContextMenuItem, GetTabContextMenuItemsParams } from "dockview";

export const TAB_CONTEXT_MENU_LABELS = [
  "Close",
  "Close Others",
  "Close to the Right",
  "Close All",
] as const;

export function createTabContextMenuItems(
  { panel, group }: GetTabContextMenuItemsParams,
  onOpen: () => void,
): ContextMenuItem[] {
  onOpen();
  const panels = [...group.panels];
  const panelIndex = panels.indexOf(panel);

  return [
    {
      label: TAB_CONTEXT_MENU_LABELS[0],
      action: () => panel.api.close(),
    },
    {
      label: TAB_CONTEXT_MENU_LABELS[1],
      disabled: panels.length <= 1,
      action: () => {
        for (const candidate of [...group.panels]) {
          if (candidate !== panel) candidate.api.close();
        }
      },
    },
    {
      label: TAB_CONTEXT_MENU_LABELS[2],
      disabled: panelIndex < 0 || panelIndex === panels.length - 1,
      action: () => {
        const currentPanels = [...group.panels];
        const currentIndex = currentPanels.indexOf(panel);
        if (currentIndex < 0) return;
        for (const candidate of currentPanels.slice(currentIndex + 1)) {
          candidate.api.close();
        }
      },
    },
    "separator",
    {
      label: TAB_CONTEXT_MENU_LABELS[3],
      action: () => {
        for (const candidate of [...group.panels]) candidate.api.close();
      },
    },
  ];
}
