import type { AgentActivity } from "./generated/AgentActivity";
import type { AgentActivityChangedDto } from "./generated/AgentActivityChangedDto";
import type { AgentSummaryDto } from "./generated/AgentSummaryDto";

export interface AgentListActions {
  focusAgent(agent: AgentSummaryDto): Promise<void>;
}

const ACTIVITY_PRIORITY: Record<AgentActivity, number> = {
  blocked: 0,
  working: 1,
  starting: 2,
  idle: 3,
  stopped: 4,
};

export function sortAgents(
  agents: readonly AgentSummaryDto[],
): AgentSummaryDto[] {
  return [...agents].sort(
    (left, right) =>
      ACTIVITY_PRIORITY[left.activity] - ACTIVITY_PRIORITY[right.activity] ||
      right.lastActiveAt - left.lastActiveAt ||
      left.spaceName.localeCompare(right.spaceName) ||
      left.displayTitle.localeCompare(right.displayTitle),
  );
}

export function formatLastActiveTime(
  lastActiveAt: number,
  now = Date.now(),
): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - lastActiveAt) / 1_000));
  if (elapsedSeconds < 60) return "now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  return new Date(lastActiveAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function applyAgentActivity(
  agent: AgentSummaryDto,
  update: AgentActivityChangedDto,
): AgentSummaryDto | null {
  if (agent.cliSessionId !== update.cliSessionId) return null;
  return {
    ...agent,
    activity: update.activity,
    runtimeId: update.activity === "stopped" ? null : update.runtimeId,
    displayTitle: update.displayTitle,
    lastActiveAt: update.lastActiveAt,
  };
}

export function isAgentForeground(
  agent: AgentSummaryDto,
  activeSpaceId: string | null,
  visibleTabIds: ReadonlySet<string>,
): boolean {
  return agent.spaceId === activeSpaceId && visibleTabIds.has(agent.tabId);
}

export class AgentListView {
  readonly #agents = new Map<string, AgentSummaryDto>();
  readonly #activeTimeRefresh: number;
  #activeSpaceId: string | null = null;
  #visibleTabIds = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: AgentListActions,
  ) {
    this.#activeTimeRefresh = window.setInterval(
      () => this.#refreshActiveTimes(),
      30_000,
    );
  }

  dispose(): void {
    window.clearInterval(this.#activeTimeRefresh);
  }

  render(agents: readonly AgentSummaryDto[]): void {
    this.#agents.clear();
    for (const agent of agents)
      this.#agents.set(agent.cliSessionId, { ...agent });
    this.#renderRows();
  }

  updateActivity(update: AgentActivityChangedDto): boolean {
    const agent = this.#agents.get(update.cliSessionId);
    if (!agent) return false;
    this.#agents.set(update.cliSessionId, applyAgentActivity(agent, update)!);
    this.#renderRows();
    return true;
  }

  setForegroundTabs(
    activeSpaceId: string | null,
    visibleTabIds: ReadonlySet<string>,
  ): void {
    this.#activeSpaceId = activeSpaceId;
    this.#visibleTabIds = new Set(visibleTabIds);
    this.#renderRows();
  }

  snapshot(): AgentSummaryDto[] {
    return sortAgents([...this.#agents.values()]);
  }

  #renderRows(): void {
    const list = requiredElement(this.root, "#agent-list");
    const agents = sortAgents([...this.#agents.values()]);
    if (agents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agent-list-empty";
      empty.textContent = "No agents yet";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...agents.map((agent) => this.#renderAgent(agent)));
  }

  #renderAgent(agent: AgentSummaryDto): HTMLButtonElement {
    const button = document.createElement("button");
    const foreground = isAgentForeground(
      agent,
      this.#activeSpaceId,
      this.#visibleTabIds,
    );
    button.type = "button";
    button.className = "agent-item";
    button.dataset.activity = agent.activity;
    button.dataset.foreground = String(foreground);
    button.dataset.cliSessionId = agent.cliSessionId;
    button.dataset.spaceId = agent.spaceId;
    button.dataset.tabId = agent.tabId;
    button.dataset.displayTitle = agent.displayTitle;
    button.dataset.lastActiveAt = String(agent.lastActiveAt);
    const lastActive = formatLastActiveTime(agent.lastActiveAt);
    const lastActiveDate = new Date(agent.lastActiveAt);
    const exactLastActive = lastActiveDate.toLocaleString();
    button.title = `${agent.spaceName} · ${agent.displayTitle} · ${agent.activity} · active ${exactLastActive}`;
    button.setAttribute(
      "aria-label",
      `${agent.displayTitle}, ${agent.activity}, last active ${exactLastActive}, ${agent.spaceName}`,
    );
    if (foreground) button.setAttribute("aria-current", "true");

    const icon = document.createElement("img");
    icon.className = "agent-item-icon";
    icon.src = `/assets/${agent.provider}-color.svg`;
    icon.alt = "";
    icon.draggable = false;

    const labels = document.createElement("span");
    labels.className = "agent-item-labels";
    const title = document.createElement("strong");
    title.textContent = agent.displayTitle;
    const space = document.createElement("small");
    space.textContent = agent.spaceName;
    labels.append(title, space);

    const metadata = document.createElement("span");
    metadata.className = "agent-item-metadata";
    const status = document.createElement("span");
    status.className = "agent-item-status";
    status.textContent = agent.activity;
    status.dataset.activity = agent.activity;
    const separator = document.createElement("span");
    separator.className = "agent-item-metadata-separator";
    separator.textContent = "·";
    separator.setAttribute("aria-hidden", "true");
    const activeTime = document.createElement("time");
    activeTime.className = "agent-item-active-time";
    activeTime.dateTime = lastActiveDate.toISOString();
    activeTime.dataset.lastActiveAt = String(agent.lastActiveAt);
    activeTime.title = `Last active ${exactLastActive}`;
    activeTime.textContent = lastActive;
    metadata.append(status, separator, activeTime);
    button.append(icon, labels, metadata);
    button.addEventListener("click", () => void this.actions.focusAgent(agent));
    return button;
  }

  #refreshActiveTimes(): void {
    for (const activeTime of this.root.querySelectorAll<HTMLTimeElement>(
      ".agent-item-active-time",
    )) {
      const lastActiveAt = Number(activeTime.dataset.lastActiveAt);
      if (Number.isFinite(lastActiveAt)) {
        activeTime.textContent = formatLastActiveTime(lastActiveAt);
      }
    }
  }
}

function requiredElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing required element: ${selector}`);
  return element;
}
