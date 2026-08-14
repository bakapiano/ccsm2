import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const artifactDirectory = process.env.CCSM_E2E_ARTIFACT_DIR!;
const fixtureRoot = process.env.CCSM_E2E_FIXTURE_ROOT;
if (!fixtureRoot) {
  throw new Error("CCSM_E2E_FIXTURE_ROOT must point to the Linux L4 fixture");
}

const fixtureFileName = "acceptance.md";
const fixtureFile = join(fixtureRoot, fixtureFileName);
const workspaceName = "L4 Workspace";
const folderName = "Acceptance Folder";
const unicodeMarker = "Linux L4 中文编辑 ✓";

interface WorkspaceUiState {
  activeName: string;
  activeRoot: string;
  globalStatus: string;
  theme: string | null;
  folders: Array<{
    id: string;
    name: string;
    expanded: boolean;
    spaces: string[];
  }>;
  unfiledSpaces: string[];
  tabs: Array<{ kind: string; title: string; active: boolean }>;
  editor: null | {
    state: string | null;
    status: string;
    content: string;
    wordWrap: boolean;
    engine: string | null;
  };
  git: null | {
    status: string;
    files: string[];
  };
  shellRuntimeId: string | null;
  browserStatus: string;
  browserNativeVisible: boolean;
}

async function workspaceUiState(): Promise<WorkspaceUiState> {
  return browser.execute(() => {
    const terminal = document.querySelector<HTMLElement>(".terminal-panel");
    const terminalState = (
      terminal as HTMLElement & {
        __CCSM_TERMINAL_DEBUG__?: () => { runtimeId: string | null };
      }
    )?.__CCSM_TERMINAL_DEBUG__?.();
    const browserPanel = document.querySelector<HTMLElement>(".browser-panel");
    const editor = document.querySelector<HTMLElement>(".file-editor-panel");
    const git = document.querySelector<HTMLElement>(".git-panel");
    return {
      activeName:
        document.querySelector("#active-space-name")?.textContent ?? "",
      activeRoot:
        document.querySelector("#active-space-root")?.textContent ?? "",
      globalStatus: document.querySelector("#global-status")?.textContent ?? "",
      theme: document.documentElement.dataset.theme ?? null,
      folders: Array.from(
        document.querySelectorAll<HTMLElement>(".folder-node[data-folder-id]"),
        (folder) => ({
          id: folder.dataset.folderId ?? "",
          name: folder.querySelector(".folder-name")?.textContent ?? "",
          expanded:
            folder
              .querySelector(".folder-row")
              ?.getAttribute("aria-expanded") === "true",
          spaces: Array.from(
            folder.querySelectorAll<HTMLElement>(
              ":scope > .folder-children > .space-row .space-name",
            ),
            (space) => space.textContent ?? "",
          ),
        }),
      ),
      unfiledSpaces: Array.from(
        document.querySelectorAll<HTMLElement>(
          ".unfiled-section > .folder-children > .space-row .space-name",
        ),
        (space) => space.textContent ?? "",
      ),
      tabs: Array.from(
        document.querySelectorAll<HTMLElement>(".ccsm-tab"),
        (tab) => ({
          kind: tab.dataset.tabKind ?? "",
          title: tab.querySelector(".ccsm-tab-label")?.textContent ?? "",
          active: Boolean(
            tab.closest(".dv-tab")?.classList.contains("dv-active-tab"),
          ),
        }),
      ),
      editor: editor
        ? {
            state: editor.dataset.state ?? null,
            status:
              editor.querySelector(".file-editor-status")?.textContent ?? "",
            content: editor.querySelector(".cm-content")?.textContent ?? "",
            wordWrap:
              editor
                .querySelector("[data-editor-action='wrap']")
                ?.getAttribute("aria-pressed") === "true",
            engine: editor.dataset.editorEngine ?? null,
          }
        : null,
      git: git
        ? {
            status: git.querySelector(".git-status")?.textContent ?? "",
            files: Array.from(
              git.querySelectorAll<HTMLElement>(".git-file-path"),
              (file) => file.textContent ?? "",
            ),
          }
        : null,
      shellRuntimeId: terminalState?.runtimeId ?? null,
      browserStatus:
        browserPanel?.querySelector(".browser-state")?.textContent ?? "",
      browserNativeVisible: browserPanel?.dataset.nativeVisible === "true",
    };
  });
}

async function writeState(name: string): Promise<WorkspaceUiState> {
  const state = await workspaceUiState();
  writeFileSync(
    join(artifactDirectory, `${name}.json`),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return state;
}

async function waitForActiveSpace(name: string): Promise<void> {
  await browser.waitUntil(
    async () => (await workspaceUiState()).activeName === name,
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `Space ${name} did not become active`,
    },
  );
}

async function waitForWorkspaceReady(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const state = await workspaceUiState();
      return (
        state.globalStatus === "ready" &&
        Boolean(state.shellRuntimeId) &&
        state.browserNativeVisible &&
        state.browserStatus.includes("ready")
      );
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "Shell and native Browser did not become ready",
    },
  );
}

async function submitTextDialog(value: string): Promise<void> {
  const dialog = await $(".app-dialog");
  await dialog.waitForDisplayed();
  await $(".app-dialog-field input").setValue(value);
  await $("[data-dialog-action='submit']").click();
  await dialog.waitForDisplayed({ reverse: true });
}

async function clickTreeAction(label: string): Promise<void> {
  const clicked = await browser.execute((ariaLabel) => {
    const button = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${CSS.escape(ariaLabel)}"]`,
    );
    button?.click();
    return Boolean(button);
  }, label);
  expect(clicked).toBe(true);
}

async function createFolder(name: string): Promise<void> {
  await $("#new-folder").click();
  await submitTextDialog(name);
  await browser.waitUntil(
    async () =>
      (await workspaceUiState()).folders.some((folder) => folder.name === name),
    { timeoutMsg: `Folder ${name} was not created` },
  );
}

async function createFixtureSpace(): Promise<void> {
  await $("#new-space").click();
  const picker = await $(".directory-dialog");
  await picker.waitForDisplayed();
  await browser.execute((path) => {
    const input =
      document.querySelector<HTMLInputElement>(".directory-address");
    if (!input) throw new Error("directory address is missing");
    input.value = path;
    document
      .querySelector<HTMLFormElement>(".directory-address-form")
      ?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
  }, fixtureRoot);
  const useFolder = await $(".directory-use");
  await browser.waitUntil(async () => useFolder.isEnabled(), {
    timeout: 15_000,
    interval: 200,
    timeoutMsg: `${fixtureRoot} did not become selectable`,
  });
  await useFolder.click();
  await submitTextDialog("L4 Fixture");
  await waitForActiveSpace("L4 Fixture");
  await waitForWorkspaceReady();
}

async function dragSpaceToFolder(
  spaceName: string,
  targetFolderName: string | null,
): Promise<void> {
  const result = await browser.execute(
    ({ requestedSpace, requestedFolder }) => {
      const source = Array.from(
        document.querySelectorAll<HTMLElement>(".space-row[data-space-id]"),
      ).find(
        (row) =>
          row.querySelector(".space-name")?.textContent === requestedSpace,
      );
      const target = requestedFolder
        ? Array.from(
            document.querySelectorAll<HTMLElement>(
              ".folder-node[data-folder-id] > .folder-row",
            ),
          ).find(
            (row) =>
              row.querySelector(".folder-name")?.textContent ===
              requestedFolder,
          )
        : document.querySelector<HTMLElement>(
            ".tree-section-label[data-drop-folder-id='']",
          );
      if (!source || !target) {
        return { ok: false, reason: "source or target missing" };
      }
      const from = source.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const pointerId = 7614;
      const startX = from.left + Math.min(72, from.width / 2);
      const startY = from.top + from.height / 2;
      const endX = to.left + Math.min(72, to.width / 2);
      const endY = to.top + to.height / 2;
      source.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: startX,
          clientY: startY,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: endX,
          clientY: endY,
        }),
      );
      const highlighted = target.dataset.dragOver === "true";
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: 0,
          clientX: endX,
          clientY: endY,
        }),
      );
      return { ok: true, highlighted };
    },
    { requestedSpace: spaceName, requestedFolder: targetFolderName },
  );
  expect(result).toEqual({ ok: true, highlighted: true });
  await browser.waitUntil(
    async () => {
      const state = await workspaceUiState();
      return targetFolderName
        ? state.folders
            .find((folder) => folder.name === targetFolderName)
            ?.spaces.includes(spaceName) === true
        : state.unfiledSpaces.includes(spaceName);
    },
    {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: `${spaceName} was not moved to ${targetFolderName ?? "Unfiled"}`,
    },
  );
}

async function activateTab(kind: string): Promise<void> {
  const panelSelector: Record<string, string> = {
    "cli-session": ".terminal-panel",
    "file-explorer": ".file-explorer-panel",
    "file-editor": ".file-editor-panel",
    git: ".git-panel",
    browser: ".browser-panel",
  };
  const tabs = await $$(`.ccsm-tab[data-tab-kind='${kind}']`);
  let clicked = false;
  for (const tab of tabs) {
    if (!(await tab.isDisplayed())) continue;
    await tab.click();
    clicked = true;
    break;
  }
  if (!clicked) {
    clicked = await browser.execute((requestedKind) => {
      const tab = document.querySelector<HTMLElement>(
        `.ccsm-tab[data-tab-kind='${CSS.escape(requestedKind)}']`,
      );
      const target = tab?.closest<HTMLElement>(".dv-tab") ?? tab;
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      target.dispatchEvent(
        new PointerEvent("pointerdown", {
          ...eventOptions,
          pointerId: 8172,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
      target.dispatchEvent(new MouseEvent("mousedown", eventOptions));
      target.dispatchEvent(
        new PointerEvent("pointerup", {
          ...eventOptions,
          buttons: 0,
          pointerId: 8172,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
      target.dispatchEvent(
        new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }),
      );
      target.dispatchEvent(
        new MouseEvent("click", { ...eventOptions, buttons: 0 }),
      );
      return true;
    }, kind);
  }
  expect(clicked).toBe(true);
  const selector = panelSelector[kind];
  if (!selector) throw new Error(`unknown Tab kind: ${kind}`);
  await $(selector).waitForDisplayed({
    timeoutMsg: `${kind} panel did not become visible`,
  });
}

async function clickVisibleFileRow(path: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((requestedPath) => {
        const panel = Array.from(
          document.querySelectorAll<HTMLElement>(".file-explorer-panel"),
        ).find((candidate) => candidate.checkVisibility());
        return Boolean(
          panel?.querySelector<HTMLElement>(
            `.file-row[data-path='${CSS.escape(requestedPath)}']`,
          ),
        );
      }, path),
    { timeout: 15_000, timeoutMsg: `${path} did not appear in Explorer` },
  );
  expect(
    await browser.execute((requestedPath) => {
      const panel = Array.from(
        document.querySelectorAll<HTMLElement>(".file-explorer-panel"),
      ).find((candidate) => candidate.checkVisibility());
      const row = panel?.querySelector<HTMLElement>(
        `.file-row[data-path='${CSS.escape(requestedPath)}']`,
      );
      row?.click();
      return Boolean(row);
    }, path),
  ).toBe(true);
}

describe("Linux workspace workflows", () => {
  before(async () => {
    mkdirSync(artifactDirectory, { recursive: true });
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(fixtureFile, "Baseline\r\n");
    execFileSync("git", ["init", "-b", "main"], {
      cwd: fixtureRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "CCSM L4"], {
      cwd: fixtureRoot,
    });
    execFileSync("git", ["config", "user.email", "ccsm-l4@example.invalid"], {
      cwd: fixtureRoot,
    });
    execFileSync("git", ["add", fixtureFileName], { cwd: fixtureRoot });
    execFileSync("git", ["commit", "-m", "baseline"], {
      cwd: fixtureRoot,
      stdio: "ignore",
    });
    await browser.pause(2_000);
    await $("#app").waitForDisplayed();
    await waitForWorkspaceReady();
  });

  it("manages folders and moves a Space to Folder and Unfiled", async () => {
    await createFolder("L4 Folder");
    await clickTreeAction("Rename folder L4 Folder");
    await submitTextDialog(folderName);
    await browser.waitUntil(
      async () =>
        (await workspaceUiState()).folders.some(
          (folder) => folder.name === folderName,
        ),
      { timeoutMsg: "Folder rename was not rendered" },
    );

    await createFolder("Delete Me");
    await clickTreeAction("Delete folder Delete Me");
    const deleteDialog = await $(".app-dialog");
    await deleteDialog.waitForDisplayed();
    await browser.saveScreenshot(
      join(artifactDirectory, "folder-delete-confirmation.png"),
    );
    await $("[data-dialog-action='cancel']").click();
    await deleteDialog.waitForDisplayed({ reverse: true });
    expect(
      (await workspaceUiState()).folders.some(
        (folder) => folder.name === "Delete Me",
      ),
    ).toBe(true);
    await clickTreeAction("Delete folder Delete Me");
    await $("[data-dialog-action='confirm']").click();
    await browser.waitUntil(
      async () =>
        !(await workspaceUiState()).folders.some(
          (folder) => folder.name === "Delete Me",
        ),
      { timeoutMsg: "Folder delete was not committed" },
    );

    await createFixtureSpace();
    await clickTreeAction("Rename Space L4 Fixture");
    await submitTextDialog(workspaceName);
    await waitForActiveSpace(workspaceName);

    await dragSpaceToFolder(workspaceName, folderName);
    await browser.saveScreenshot(
      join(artifactDirectory, "space-inside-folder.png"),
    );
    await dragSpaceToFolder(workspaceName, null);
    await dragSpaceToFolder(workspaceName, folderName);

    const folderRow = await $(
      `.folder-node[data-folder-id] > .folder-row[aria-expanded='true']`,
    );
    await folderRow.click();
    await browser.waitUntil(
      async () =>
        (await workspaceUiState()).folders.find(
          (folder) => folder.name === folderName,
        )?.expanded === false,
      { timeoutMsg: "Folder collapse was not committed" },
    );
    await browser.saveScreenshot(
      join(artifactDirectory, "space-folder-collapsed.png"),
    );
    await browser.execute((requestedFolder) => {
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".folder-node[data-folder-id] > .folder-row",
        ),
      )
        .find(
          (row) =>
            row.querySelector(".folder-name")?.textContent === requestedFolder,
        )
        ?.click();
    }, folderName);
    await browser.waitUntil(
      async () =>
        (await workspaceUiState()).folders.find(
          (folder) => folder.name === folderName,
        )?.expanded === true,
      { timeoutMsg: "Folder expand was not committed" },
    );
    await writeState("space-folder-state");
  });

  it("opens, deduplicates, edits, protects, and saves a Unicode file", async () => {
    await activateTab("file-explorer");
    await clickVisibleFileRow(fixtureFileName);

    const editor = await $(".file-editor-panel");
    await editor.waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(
      async () =>
        editor.getAttribute("data-state").then((state) => state === "clean"),
      { timeoutMsg: "File Editor did not finish loading" },
    );
    expect(await editor.getAttribute("data-editor-engine")).toBe("codemirror6");
    expect(await $$(".ccsm-tab[data-tab-kind='file-editor']")).toHaveLength(1);

    await activateTab("file-explorer");
    await clickVisibleFileRow(fixtureFileName);
    await editor.waitForDisplayed();
    expect(await $$(".ccsm-tab[data-tab-kind='file-editor']")).toHaveLength(1);

    const content = await $(".file-editor-panel .cm-content");
    await content.click();
    await browser.keys("End");
    await browser.keys(`\n${unicodeMarker}\n`);
    await browser.waitUntil(
      async () =>
        editor.getAttribute("data-state").then((state) => state === "dirty"),
      { timeoutMsg: "File Editor did not become dirty" },
    );
    await browser.waitUntil(
      async () => (await workspaceUiState()).editor?.status === "Unsaved",
      { timeoutMsg: "File Editor did not render the Unsaved status" },
    );
    expect(
      (await workspaceUiState()).tabs.some(
        (tab) => tab.kind === "file-editor" && tab.title.includes("●"),
      ),
    ).toBe(true);
    await browser.saveScreenshot(join(artifactDirectory, "editor-dirty.png"));

    expect(
      await browser.execute(() => {
        const close = document.querySelector<HTMLButtonElement>(
          ".ccsm-tab[data-tab-kind='file-editor'] .ccsm-tab-close",
        );
        close?.click();
        return Boolean(close);
      }),
    ).toBe(true);
    const closeDialog = await $(".app-dialog");
    await closeDialog.waitForDisplayed();
    expect(await $(".app-dialog-head h2").getText()).toContain(
      `Save changes to ${fixtureFileName}`,
    );
    await browser.saveScreenshot(
      join(artifactDirectory, "editor-close-cancel.png"),
    );
    await $("[data-dialog-action='cancel']").click();
    await closeDialog.waitForDisplayed({ reverse: true });
    await editor.waitForDisplayed();
    expect(await editor.getAttribute("data-state")).toBe("dirty");
    expect((await workspaceUiState()).editor?.content).toContain(unicodeMarker);

    await $("[data-editor-action='save']").click();
    await browser.waitUntil(
      async () =>
        editor.getAttribute("data-state").then((state) => state === "clean"),
      { timeout: 15_000, timeoutMsg: "File Editor did not save" },
    );
    const bytes = readFileSync(fixtureFile);
    const saved = bytes.toString("utf8");
    expect(saved).toContain(unicodeMarker);
    expect(saved).toContain("\r\n");

    await $("[data-editor-action='wrap']").click();
    await browser.waitUntil(
      async () =>
        $("[data-editor-action='wrap']")
          .getAttribute("aria-pressed")
          .then((value) => value === "true"),
      { timeoutMsg: "Word wrap state was not updated" },
    );
    await browser.saveScreenshot(join(artifactDirectory, "editor-saved.png"));
    await writeState("editor-saved-state");
  });

  it("refreshes Git and leaves a restorable workspace", async () => {
    await activateTab("git");
    expect(
      await browser.execute(() => {
        const panel = Array.from(
          document.querySelectorAll<HTMLElement>(".git-panel"),
        ).find((candidate) => candidate.checkVisibility());
        const refresh = panel?.querySelector<HTMLButtonElement>(".git-refresh");
        refresh?.click();
        return Boolean(refresh);
      }),
    ).toBe(true);
    await browser.waitUntil(
      async () => {
        const status = (await workspaceUiState()).git?.status ?? "";
        return status.includes("1 repos") && status.includes("1 changes");
      },
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "Git did not report the modified acceptance file",
      },
    );
    expect((await workspaceUiState()).git?.files).toContain(fixtureFileName);
    await browser.saveScreenshot(join(artifactDirectory, "git-change.png"));

    await activateTab("file-editor");
    await browser.execute(() => window.__CCSM_DEBUG__.app.flushLayout());
    const finalState = await writeState("workspace-before-restart");
    expect(finalState.activeName).toBe(workspaceName);
    expect(finalState.activeRoot).toBe(fixtureRoot);
    expect(finalState.editor?.state).toBe("clean");
    expect(finalState.editor?.wordWrap).toBe(true);
    expect(finalState.shellRuntimeId).not.toBeNull();
  });
});
