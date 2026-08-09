import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { AgentSummaryDto } from "./generated/AgentSummaryDto";
import {
  AgentListView,
  applyAgentActivity,
  isAgentForeground,
  sortAgents,
} from "./agent-list";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function agent(
  id: string,
  activity: AgentSummaryDto["activity"],
  spaceName = "Space",
): AgentSummaryDto {
  return {
    cliSessionId: id,
    spaceId: `space-${id}`,
    spaceName,
    tabId: `tab-${id}`,
    tabTitle: id,
    provider: id.includes("claude") ? "claude" : "codex",
    activity,
    runtimeId: activity === "stopped" ? null : `runtime-${id}`,
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

  test("applies only matching runtime activity updates", () => {
    const current = agent("codex", "idle");
    expect(
      applyAgentActivity(current, {
        cliSessionId: "codex",
        runtimeId: "runtime-new",
        activity: "working",
      }),
    ).toMatchObject({ activity: "working", runtimeId: "runtime-new" });
    expect(
      applyAgentActivity(current, {
        cliSessionId: "other",
        runtimeId: "runtime-other",
        activity: "blocked",
      }),
    ).toBeNull();
    expect(
      applyAgentActivity(current, {
        cliSessionId: "codex",
        runtimeId: "runtime-new",
        activity: "stopped",
      })?.runtimeId,
    ).toBeNull();
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
  });
});
