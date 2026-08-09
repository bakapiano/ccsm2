import type { ProviderKind } from "./generated/ProviderKind";
import type { TabKind } from "./generated/TabKind";

export type NewTabAction =
  | { id: string; label: string; type: "cli"; provider: ProviderKind }
  | { id: string; label: string; type: "tab"; tabKind: TabKind };

export const NEW_TAB_ACTIONS: readonly NewTabAction[] = [
  { id: "shell", label: "Shell", type: "cli", provider: "shell" },
  { id: "claude", label: "Claude Code", type: "cli", provider: "claude" },
  { id: "codex", label: "Codex", type: "cli", provider: "codex" },
  { id: "browser", label: "Browser", type: "tab", tabKind: "browser" },
  {
    id: "files",
    label: "File Explorer",
    type: "tab",
    tabKind: "file-explorer",
  },
  { id: "git", label: "Git", type: "tab", tabKind: "git" },
];
