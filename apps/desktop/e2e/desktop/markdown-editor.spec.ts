import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ScenarioEvidence } from "./support/evidence";

const artifactDirectory = requiredEnvironment("CCSM_E2E_ARTIFACT_DIR");
const spaceRootBase = requiredEnvironment("CCSM_E2E_TARGET_ROOT_BASE");
const runId = requiredEnvironment("CCSM_E2E_RUN_ID");
const scenarioId = "markdown-edit-preview";

describe("Markdown file editor", () => {
  it("edits and previews Markdown", async () => {
    const evidence = new ScenarioEvidence(scenarioId);
    const spaceName = `E2E Markdown ${runId}`;
    const spaceRoot = join(spaceRootBase, "markdown");
    const markdownPath = join(spaceRoot, "README.md");
    mkdirSync(spaceRoot, { recursive: true });
    writeFileSync(
      markdownPath,
      [
        "# Markdown Edit & Preview",
        "",
        "Rendered with **markdown-it** inside CCSM.",
        "",
        "| Mode | State |",
        "| --- | --- |",
        "| Preview | Ready |",
        "",
        "<strong data-e2e-raw>escaped HTML</strong>",
      ].join("\n"),
    );

    let primaryError: unknown;
    let currentStep = "create-space";
    try {
      await restoreScenarioUi();
      await createSpace(spaceName, spaceRoot);

      currentStep = "open-markdown";
      await openFileExplorer();
      const fileRow = await $('.file-row[data-path="README.md"]');
      await fileRow.waitForDisplayed({ timeout: 30_000 });
      await fileRow.click();

      const panel = await $(
        '.file-editor-panel[data-editor-engine="markdown"]',
      );
      await panel.waitForDisplayed({ timeout: 30_000 });
      const previewButton = await panel.$(
        '[data-editor-action="markdown-preview"]',
      );
      await browser.waitUntil(
        async () =>
          (await previewButton.getAttribute("aria-pressed")) === "true",
        { timeoutMsg: "Markdown did not open in Preview mode" },
      );
      const preview = await panel.$(".file-editor-markdown-preview");
      await preview.$("h1=Markdown Edit & Preview").waitForDisplayed();
      expect(await preview.$("table").isDisplayed()).toBe(true);
      expect(await preview.$("[data-e2e-raw]").isExisting()).toBe(false);
      expect(await preview.getText()).toContain(
        "<strong data-e2e-raw>escaped HTML</strong>",
      );
      await evidence.checkpoint("initial-preview");

      currentStep = "edit-markdown";
      const editButton = await panel.$('[data-editor-action="markdown-edit"]');
      await editButton.click();
      await browser.waitUntil(
        async () => (await editButton.getAttribute("aria-pressed")) === "true",
        { timeoutMsg: "Markdown did not enter Edit mode" },
      );
      const editor = await panel.$('.cm-content[aria-label="Edit README.md"]');
      await editor.waitForDisplayed();
      await editor.click();
      await editor.addValue("## Saved from E2E");
      await browser.keys("Enter");
      await browser.keys("Enter");
      await browser.waitUntil(
        async () =>
          (await panel.getAttribute("data-state")) === "dirty" &&
          (await editor.getText()).includes("## Saved from E2E"),
        { timeoutMsg: "Markdown edit did not become dirty" },
      );
      await evidence.checkpoint("dirty-edit");

      currentStep = "preview-edit";
      await previewButton.click();
      await preview.$("h2=Saved from E2E").waitForDisplayed();
      expect(await panel.getAttribute("data-state")).toBe("dirty");
      await evidence.checkpoint("edited-preview");

      currentStep = "save-markdown";
      await preview.click();
      await browser.keys(["Control", "s"]);
      await browser.waitUntil(
        async () =>
          (await panel.getAttribute("data-state")) === "clean" &&
          readFileSync(markdownPath, "utf8").includes("## Saved from E2E"),
        { timeout: 30_000, timeoutMsg: "Markdown save did not reach disk" },
      );
      expect(readFileSync(markdownPath, "utf8")).toContain("## Saved from E2E");

      currentStep = "saved-preview";
      await preview.$("h2=Saved from E2E").waitForDisplayed();
      expect(await panel.getAttribute("data-state")).toBe("clean");
      await evidence.checkpoint("saved-preview");
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
  await dismissKnownOverlays();
}

async function dismissKnownOverlays(): Promise<void> {
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

async function createSpace(name: string, root: string): Promise<void> {
  await $("#new-space").click();
  const picker = await $(".directory-dialog");
  await picker.waitForDisplayed();
  await $(".directory-address").setValue(root);
  await $(".directory-address-submit").click();
  const useFolder = await $(".directory-use");
  await browser.waitUntil(
    async () => {
      const breadcrumbs = await $$(".directory-breadcrumbs button");
      const selectedPath =
        await breadcrumbs[(await breadcrumbs.length) - 1]?.getAttribute(
          "title",
        );
      return Boolean(
        selectedPath &&
          normalizedPath(selectedPath) === normalizedPath(root) &&
          (await useFolder.isEnabled()),
      );
    },
    { timeout: 20_000, timeoutMsg: `${root} did not become selectable` },
  );
  await useFolder.click();

  const dialog = await $(".app-dialog");
  await dialog.waitForDisplayed();
  await $(".app-dialog-field input").setValue(name);
  await $("[data-dialog-action='submit']").click();
  await dialog.waitForDisplayed({ reverse: true });
  await browser.waitUntil(async () => (await activeSpaceName()) === name, {
    timeout: 30_000,
    timeoutMsg: `Space ${name} did not become active`,
  });
}

async function openFileExplorer(): Promise<void> {
  await $(".dock-new-tab-button").click();
  const menu = await $("#new-tab-menu");
  await menu.waitForDisplayed();
  await $("#new-tab-menu [data-new-tab-action='files']").click();
  await menu.waitForDisplayed({ reverse: true });
}

async function activeSpaceName(): Promise<string> {
  return browser.execute(
    () => document.querySelector("#active-space-name")?.textContent ?? "",
  );
}

function normalizedPath(path: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(path);
  } catch {
    canonicalPath = resolve(path);
  }
  const normalized = canonicalPath.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
