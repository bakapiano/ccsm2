import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const enabled = process.env.CCSM_E2E_HANG_STRESS_PHASE === "recovery";
const artifactDirectory = process.env.CCSM_E2E_ARTIFACT_DIR!;

(enabled ? describe : describe.skip)("hang-resilience cold recovery", () => {
  before(() => mkdirSync(artifactDirectory, { recursive: true }));

  it("restores sixty-one editor Tabs with only visible renderers materialized", async () => {
    await browser.setWindowSize(1_439, 899);
    await browser.setWindowSize(1_440, 900);
    await browser.waitUntil(
      () =>
        browser.execute(
          () => window.innerWidth >= 1_000 && window.innerHeight >= 700,
        ),
      {
        timeout: 15_000,
        timeoutMsg: "recovery viewport did not reach a usable size",
      },
    );
    await $("#app").waitForDisplayed({ timeout: 30_000 });
    await browser.pause(2_000);
    const preflight = await browser.execute(() => ({
      activeSpace: document.querySelector("#active-space-name")?.textContent,
      globalStatus: document.querySelector("#global-status")?.textContent,
      snapshot: window.__CCSM_DEBUG__.snapshot(),
    }));
    writeFileSync(
      join(artifactDirectory, "stress-recovery-preflight.json"),
      `${JSON.stringify(preflight, null, 2)}\n`,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelector("#active-space-name")?.textContent ===
              "Hang Stress" &&
            document.querySelector("#global-status")?.textContent === "ready",
        ),
      { timeout: 45_000, timeoutMsg: "stress workspace did not recover" },
    );
    const initial = await browser.execute(() => ({
      startupMs: performance.now(),
      snapshot: window.__CCSM_DEBUG__.snapshot(),
      editorTabs: document.querySelectorAll(
        ".ccsm-tab[data-tab-kind='file-editor']",
      ).length,
      mountedEditors: document.querySelectorAll(".file-editor-panel").length,
    }));
    const restore = (
      initial.snapshot as {
        tabRestore?: { materialized: number; pending: number };
      }
    ).tabRestore;
    expect(initial.editorTabs).toBe(61);
    expect(initial.mountedEditors).toBeLessThanOrEqual(2);
    expect(restore?.materialized ?? 999).toBeLessThanOrEqual(4);

    const materializedBefore = restore?.materialized ?? 0;
    const overflow = await $(".dv-tabs-overflow-dropdown-root");
    await overflow.waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "restored Tab overflow control was absent",
    });
    expect(
      await browser.execute(() => {
        const button = document.querySelector<HTMLElement>(
          ".dv-tabs-overflow-dropdown-root",
        );
        button?.click();
        return Boolean(button);
      }),
    ).toBe(true);
    await $(".dv-tabs-overflow-container").waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "restored Tab overflow menu did not open",
    });
    const activatedTabId = await browser.execute(() => {
      const snapshot = window.__CCSM_DEBUG__.snapshot() as {
        panels?: Array<{ id: string; active: boolean }>;
      };
      const active = new Set(
        snapshot.panels
          ?.filter((panel) => panel.active)
          .map((panel) => panel.id),
      );
      const materializedEditors = new Set(
        Array.from(
          document.querySelectorAll<HTMLElement>(".deferred-tab-renderer"),
        )
          .filter((renderer) => renderer.querySelector(".file-editor-panel"))
          .map((renderer) => renderer.dataset.tabId),
      );
      const tab = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".dv-tabs-overflow-container .ccsm-tab[data-tab-kind='file-editor']",
        ),
      ).find(
        (candidate) =>
          candidate.dataset.tabId &&
          !active.has(candidate.dataset.tabId) &&
          !materializedEditors.has(candidate.dataset.tabId),
      );
      tab?.closest<HTMLElement>(".dv-tab")?.click();
      return tab?.dataset.tabId ?? null;
    });
    expect(activatedTabId).not.toBeNull();
    await browser.waitUntil(
      () =>
        browser.execute((previous) => {
          const snapshot = window.__CCSM_DEBUG__.snapshot() as {
            tabRestore?: { materialized: number };
          };
          return (snapshot.tabRestore?.materialized ?? 0) > previous;
        }, materializedBefore),
      {
        timeout: 15_000,
        timeoutMsg: "inactive Tab did not materialize on demand",
      },
    );
    const final = await browser.execute(() => ({
      snapshot: window.__CCSM_DEBUG__.snapshot(),
      mountedEditors: document.querySelectorAll(".file-editor-panel").length,
    }));
    expect(final.mountedEditors).toBeLessThanOrEqual(2);
    writeFileSync(
      join(artifactDirectory, "stress-tabs-after-restart.json"),
      `${JSON.stringify({ initial, final }, null, 2)}\n`,
    );
  });
});
