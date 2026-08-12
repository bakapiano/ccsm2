import type { CliSessionDto } from "./generated/CliSessionDto";
import type { TabDto } from "./generated/TabDto";

export interface TabCloseApproval {
  cliSessions: readonly CliSessionDto[];
  confirmAgentCli(tab: TabDto): Promise<boolean>;
  confirmFileEditor(tab: TabDto): Promise<boolean>;
  closePanel(): boolean;
}

export function requiresAgentCliCloseConfirmation(
  tab: TabDto,
  cliSessions: readonly CliSessionDto[],
): boolean {
  if (tab.kind !== "cli-session" || !tab.resourceId) return false;
  const provider = cliSessions.find(
    (session) => session.id === tab.resourceId,
  )?.provider;
  return provider !== undefined && provider !== "shell";
}

export async function closeTabAfterApproval(
  tab: TabDto,
  approval: TabCloseApproval,
): Promise<boolean> {
  if (
    requiresAgentCliCloseConfirmation(tab, approval.cliSessions) &&
    !(await approval.confirmAgentCli(tab))
  ) {
    return false;
  }
  if (tab.kind === "file-editor" && !(await approval.confirmFileEditor(tab))) {
    return false;
  }
  return approval.closePanel();
}
