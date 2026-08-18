import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ScenarioEvidence } from "./support/evidence";

interface SidebarSnapshot {
  collapsed: boolean;
  sidebarWidth: number;
  workspaceLeft: number;
  storedCollapsed: string | null;
  toggleRightInset: number;
  toggleBottomInset: number;
  visibleSidebarChildren: string[];
}

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const scenarioId = "sidebar-collapse";

describe("Sidebar navigation", () => {
  it("collapses and expands the sidebar", async () => {
    const evidence = new ScenarioEvidence(scenarioId);
    let primaryError: unknown;
    let currentStep = "expanded-sidebar";

    try {
      await restoreScenarioUi();
      const toggle = await $('[data-testid="sidebar-toggle"]');
      await toggle.waitForDisplayed();
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
        await waitForSidebarState(false);
      }

      const expanded = await sidebarSnapshot();
      expect(expanded.collapsed).toBe(false);
      expect(expanded.sidebarWidth).toBeGreaterThan(40);
      expect(await toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
      expect(await $(".sidebar-toolbar").isDisplayed()).toBe(true);
      expect(await $(".sidebar-tree-scroll").isDisplayed()).toBe(true);
      expect(await $(".agents-panel").isDisplayed()).toBe(true);
      expect(expanded.toggleRightInset).toBeGreaterThanOrEqual(8);
      expect(expanded.toggleRightInset).toBeLessThanOrEqual(9);
      expect(expanded.toggleBottomInset).toBeGreaterThanOrEqual(4);
      expect(expanded.toggleBottomInset).toBeLessThanOrEqual(5);
      await evidence.checkpoint("expanded-sidebar");

      currentStep = "collapse-sidebar";
      await toggle.click();
      await waitForSidebarState(true);

      const collapsed = await sidebarSnapshot();
      expect(collapsed.sidebarWidth).toBe(40);
      expect(collapsed.workspaceLeft).toBeLessThan(expanded.workspaceLeft);
      expect(collapsed.storedCollapsed).toBe("true");
      expect(collapsed.visibleSidebarChildren).toEqual(["sidebar-toggle"]);
      expect(await toggle.getAttribute("aria-label")).toBe("Expand sidebar");
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await $("#sidebar-resizer").isDisplayed()).toBe(false);
      await evidence.checkpoint("collapsed-sidebar");

      currentStep = "restore-collapsed-sidebar";
      await browser.refresh();
      await $("#app").waitForDisplayed({ timeout: 60_000 });
      await $('[data-testid="sidebar-toggle"]').waitForDisplayed();
      await waitForSidebarState(true);

      const restored = await sidebarSnapshot();
      expect(restored.sidebarWidth).toBe(40);
      expect(restored.visibleSidebarChildren).toEqual(["sidebar-toggle"]);
      expect(restored.storedCollapsed).toBe("true");
      await evidence.checkpoint("restored-collapsed-sidebar");

      currentStep = "expand-sidebar";
      const restoredToggle = await $('[data-testid="sidebar-toggle"]');
      await restoredToggle.click();
      await waitForSidebarState(false);

      const expandedAgain = await sidebarSnapshot();
      expect(expandedAgain.sidebarWidth).toBe(expanded.sidebarWidth);
      expect(expandedAgain.storedCollapsed).toBe("false");
      expect(await restoredToggle.getAttribute("aria-label")).toBe(
        "Collapse sidebar",
      );
      expect(await $(".sidebar-toolbar").isDisplayed()).toBe(true);
      expect(await $(".sidebar-tree-scroll").isDisplayed()).toBe(true);
      expect(await $(".agents-panel").isDisplayed()).toBe(true);
      expect(await $("#sidebar-resizer").isDisplayed()).toBe(true);
      await evidence.checkpoint("expanded-again");
    } catch (error) {
      primaryError = error;
      writeFileSync(
        join(artifactDirectory, `${scenarioId}-failure-context.json`),
        `${JSON.stringify(
          {
            scenarioId,
            failureStep: currentStep,
            error: String(error),
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      try {
        await evidence.checkpoint(
          primaryError ? `failed-${currentStep}` : "final-state",
        );
      } catch (error) {
        primaryError ??= error;
      }
      try {
        evidence.finalize();
      } catch (error) {
        primaryError ??= error;
      }
    }

    if (primaryError) throw primaryError;
  });
});

async function restoreScenarioUi(): Promise<void> {
  await browser.maximizeWindow();
  await browser.setWindowRect(20, 20, 1320, 800);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const open = await browser.execute(() =>
      Boolean(
        document.querySelector(".directory-dialog") ||
          document.querySelector(".app-dialog") ||
          !document.querySelector<HTMLElement>("#new-tab-menu")?.hidden,
      ),
    );
    if (!open) return;
    await browser.keys("Escape");
    await browser.pause(100);
  }
}

async function waitForSidebarState(collapsed: boolean): Promise<void> {
  await browser.waitUntil(
    async () => {
      const rootState = await $("#app").getAttribute("data-sidebar-collapsed");
      const expandedState = await $(
        '[data-testid="sidebar-toggle"]',
      ).getAttribute("aria-expanded");
      return (
        rootState === String(collapsed) && expandedState === String(!collapsed)
      );
    },
    {
      timeoutMsg: `Sidebar did not reach ${collapsed ? "collapsed" : "expanded"} state`,
    },
  );
}

async function sidebarSnapshot(): Promise<SidebarSnapshot> {
  return browser.execute(() => {
    const root = document.querySelector<HTMLElement>("#app");
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const workspace = document.querySelector<HTMLElement>(".workspace");
    const toggle = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-toggle"]',
    );
    if (!root || !sidebar || !workspace || !toggle) {
      throw new Error("Sidebar shell is incomplete");
    }

    const sidebarRect = sidebar.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const toggleRect = toggle.getBoundingClientRect();
    const visibleSidebarChildren = [...sidebar.children]
      .filter((child) => {
        const element = child as HTMLElement;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((child) => {
        const element = child as HTMLElement;
        return element.id || element.classList.item(0) || element.tagName;
      });

    return {
      collapsed: root.dataset.sidebarCollapsed === "true",
      sidebarWidth: Math.round(sidebarRect.width),
      workspaceLeft: Math.round(workspaceRect.left),
      storedCollapsed: localStorage.getItem("ccsm.sidebar.collapsed"),
      toggleRightInset: Math.round(sidebarRect.right - toggleRect.right),
      toggleBottomInset: Math.round(sidebarRect.bottom - toggleRect.bottom),
      visibleSidebarChildren,
    };
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
