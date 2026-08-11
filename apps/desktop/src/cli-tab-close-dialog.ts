import type { AppDialogOptions } from "./app-dialog";
import type { TabDto } from "./generated/TabDto";

export type CliTabCloseAction = "cancel" | "close";

export function cliTabCloseDialogOptions(
  tab: Pick<TabDto, "title">,
): AppDialogOptions<CliTabCloseAction> {
  return {
    title: `Close CLI Tab “${tab.title}”?`,
    message:
      "Closing this Tab stops its process tree and permanently deletes the Tab and CLI Session records from data.db. Files on disk and provider transcripts are preserved.",
    actions: [
      { id: "cancel", label: "Cancel", autofocus: true },
      {
        id: "close",
        label: "Close and Delete",
        danger: true,
      },
    ],
    cancelAction: "cancel",
    role: "alertdialog",
    tone: "danger",
  };
}
