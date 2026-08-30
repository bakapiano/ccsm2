import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { AgentSummaryDto } from "./generated/AgentSummaryDto";
import {
  AgentListView,
  applyAgentActivity,
  formatLastActiveTime,
  isAgentForeground,
  sortAgents,
} from "./agent-list";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function agent(
  id: string,
  activity: AgentSummaryDto["activity"],
  spaceName = "Space",
  lastActiveAt = Date.UTC(2026, 7, 29, 12),
): AgentSummaryDto {
  return {
    cliSessionId: id,
    spaceId: `space-${id}`,
    spaceName,
    tabId: `tab-${id}`,
    tabTitle: id,
    displayTitle: id,
    provider: id.includes("claude") ? "claude" : "codex",
    activity,
    runtimeId: activity === "stopped" ? null : `runtime-${id}`,
    lastActiveAt,
  };
}

describe("Agents sidebar", () => {
  test("sorts attention states before idle and stopped agents", () => {
    const sorted = sortAgents([
      agent("stopped", "stopped"),
      agent("idle", "idle"),
      agent("working", "working"),
      agent("blocked", "blocked"),
      agent("starting", "starting"),
    ]);

    expect(sorted.map((item) => item.activity)).toEqual([
      "blocked",
      "working",
      "starting",
      "idle",
      "stopped",
    ]);
  });

  test("sorts the newest agent first within the same activity", () => {
    const sorted = sortAgents([
      agent("older", "idle", "Space", 1_000),
      agent("newest", "idle", "Space", 3_000),
      agent("middle", "idle", "Space", 2_000),
    ]);

    expect(sorted.map((item) => item.displayTitle)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
  });

  test("formats compact last-active times", () => {
    const now = Date.UTC(2026, 7, 29, 12);
    expect(formatLastActiveTime(now - 30_000, now)).toBe("now");
    expect(formatLastActiveTime(now - 5 * 60_000, now)).toBe("5m");
    expect(formatLastActiveTime(now - 3 * 60 * 60_000, now)).toBe("3h");
    expect(formatLastActiveTime(now - 2 * 24 * 60 * 60_000, now)).toBe("2d");
  });

  test("applies only matching runtime activity updates", () => {
    const current = agent("codex", "idle");
    expect(
      applyAgentActivity(current, {
        cliSessionId: "codex",
        runtimeId: "runtime-new",
        activity: "working",
        displayTitle: "Fix authentication",
        lastActiveAt: 2_000,
      }),
    ).toMatchObject({
      activity: "working",
      runtimeId: "runtime-new",
      displayTitle: "Fix authentication",
      lastActiveAt: 2_000,
    });
    expect(
      applyAgentActivity(current, {
        cliSessionId: "other",
        runtimeId: "runtime-other",
        activity: "blocked",
        displayTitle: "Other task",
        lastActiveAt: 3_000,
      }),
    ).toBeNull();
    expect(
      applyAgentActivity(current, {
        cliSessionId: "codex",
        runtimeId: "runtime-new",
        activity: "stopped",
        displayTitle: "Fix authentication",
        lastActiveAt: 4_000,
      })?.runtimeId,
    ).toBeNull();
  });

  test("renders the session title and last-active time", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div id="agent-list"></div>';
    const codex = agent("codex", "idle");
    codex.displayTitle = "Fix authentication";
    codex.lastActiveAt = Date.now();
    const view = new AgentListView(root, { focusAgent: async () => {} });

    view.render([codex]);

    expect(root.querySelector(".agent-item-labels strong")?.textContent).toBe(
      "Fix authentication",
    );
    expect(root.querySelector(".agent-item-active-time")?.textContent).toBe(
      "now",
    );
    expect(root.querySelector(".agent-item-metadata")?.textContent).toBe(
      "idle·now",
    );
    view.dispose();
  });

  test("selects only agents visible in the active Space", () => {
    const codex = agent("codex", "working", "Current");
    const claude = agent("claude", "idle", "Other");
    codex.spaceId = "space-current";
    claude.spaceId = "space-other";

    expect(
      isAgentForeground(codex, "space-current", new Set([codex.tabId])),
    ).toBe(true);
    expect(
      isAgentForeground(claude, "space-current", new Set([claude.tabId])),
    ).toBe(false);
  });

  test("clears the selected background as soon as a visible Tab closes", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div id="agent-list"></div>';
    const codex = agent("codex", "working");
    const view = new AgentListView(root, {
      focusAgent: async () => {},
    });
    view.render([codex]);
    view.setForegroundTabs(codex.spaceId, new Set([codex.tabId]));

    const row = root.querySelector<HTMLElement>(".agent-item");
    expect(row?.dataset.foreground).toBe("true");
    expect(row?.getAttribute("aria-current")).toBe("true");

    view.setForegroundTabs(codex.spaceId, new Set());
    const updated = root.querySelector<HTMLElement>(".agent-item");
    expect(updated?.dataset.foreground).toBe("false");
    expect(updated?.hasAttribute("aria-current")).toBe(false);
    view.dispose();
  });
});
