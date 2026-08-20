import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ScenarioEvidence } from "./support/evidence";

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const scenarioId = "settings-update";

describe("Application settings", () => {
  it("opens Settings and checks updates", async () => {
    const evidence = new ScenarioEvidence(scenarioId);
    let primaryError: unknown;
    let currentStep = "open-settings";

    try {
      await closeOpenOverlays();
      const settingsButton = await $('[data-testid="settings-button"]');
      await settingsButton.waitForDisplayed();
      await settingsButton.click();
      const dialog = await $(".settings-dialog");
      await dialog.waitForDisplayed();
      expect(await dialog.getAttribute("role")).toBe("dialog");
      expect(await $(".settings-dialog-head h2").getText()).toBe("Settings");
      expect(await $('[data-settings-action="upgrade"]').isDisplayed()).toBe(
        false,
      );
      await evidence.checkpoint("settings-open");

      currentStep = "change-theme";
      const initialTheme = await browser.execute(
        () => document.documentElement.dataset.theme ?? "light",
      );
      const nextTheme = initialTheme === "dark" ? "light" : "dark";
      await $(`[data-theme-choice="${nextTheme}"]`).click();
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => document.documentElement.dataset.theme,
          )) === nextTheme,
        { timeoutMsg: `Theme did not change to ${nextTheme}` },
      );
      expect(
        await $(`[data-theme-choice="${nextTheme}"]`).getAttribute(
          "aria-checked",
        ),
      ).toBe("true");
      await evidence.checkpoint(`${nextTheme}-theme`);

      currentStep = "check-updates";
      await $('[data-settings-action="check"]').click();
      await browser.waitUntil(
        async () =>
          (await $(".settings-update-status").getText()).includes(
            "installed release builds",
          ),
        { timeoutMsg: "Settings did not report the E2E update state" },
      );
      await evidence.checkpoint("update-check-result");

      currentStep = "restore-theme";
      await $(`[data-theme-choice="${initialTheme}"]`).click();
      await $('[data-settings-action="close"]').click();
      await dialog.waitForDisplayed({ reverse: true });
      expect(await settingsButton.isFocused()).toBe(true);

      await settingsButton.click();
      await $(".settings-dialog").waitForDisplayed();
      expect(
        await $(`[data-theme-choice="${initialTheme}"]`).getAttribute(
          "aria-checked",
        ),
      ).toBe("true");
      await evidence.checkpoint("settings-reopened");
      await $('[data-settings-action="close"]').click();
    } catch (error) {
      primaryError = error;
      writeFileSync(
        join(artifactDirectory, `${scenarioId}-failure-context.json`),
        `${JSON.stringify(
          { scenarioId, failureStep: currentStep, error: String(error) },
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

async function closeOpenOverlays(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const open = await browser.execute(() =>
      Boolean(
        document.querySelector(".settings-dialog") ||
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
