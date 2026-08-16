import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const artifactDirectory = process.env.CCSM_E2E_ARTIFACT_DIR!;
const fixtureRoot = process.env.CCSM_E2E_FIXTURE_ROOT;
if (!fixtureRoot) {
  throw new Error("CCSM_E2E_FIXTURE_ROOT must point to the Linux L4 fixture");
}

const workspaceName = "L4 Workspace";
const folderName = "Acceptance Folder";
const fixtureFileName = "acceptance.txt";
const unicodeMarker = "Linux L4 中文编辑 ✓";

interface RecoveryState {
  activeName: string;
  activeRoot: string;
  globalStatus: string;
  folderExpanded: boolean;
  workspaceInsideFolder: boolean;
  editorCount: number;
  editorVisible: boolean;
  editorState: string | null;
  editorContent: string;
  wordWrap: boolean;
  shellRuntimeId: string | null;
  browserStatus: string;
  browserNativeVisible: boolean;
}

async function recoveryState(): Promise<RecoveryState> {
  return browser.execute(
    ({ requestedFolder, requestedWorkspace }) => {
      const folder = Array.from(
        document.querySelectorAll<HTMLElement>(".folder-node[data-folder-id]"),
      ).find(
        (candidate) =>
          candidate.querySelector(".folder-name")?.textContent ===
          requestedFolder,
      );
      const editor = document.querySelector<HTMLElement>(".file-editor-panel");
      const terminal = document.querySelector<HTMLElement>(".terminal-panel");
      const terminalState = (
        terminal as HTMLElement & {
          __CCSM_TERMINAL_DEBUG__?: () => { runtimeId: string | null };
        }
      )?.__CCSM_TERMINAL_DEBUG__?.();
      const browserPanel =
        document.querySelector<HTMLElement>(".browser-panel");
      return {
        activeName:
          document.querySelector("#active-space-name")?.textContent ?? "",
        activeRoot:
          document.querySelector("#active-space-root")?.textContent ?? "",
        globalStatus:
          document.querySelector("#global-status")?.textContent ?? "",
        folderExpanded:
          folder
            ?.querySelector(".folder-row")
            ?.getAttribute("aria-expanded") === "true",
        workspaceInsideFolder: Array.from(
          folder?.querySelectorAll<HTMLElement>(
            ":scope > .folder-children > .space-row .space-name",
          ) ?? [],
          (space) => space.textContent ?? "",
        ).includes(requestedWorkspace),
        editorCount: document.querySelectorAll(
          ".ccsm-tab[data-tab-kind='file-editor']",
        ).length,
        editorVisible: Boolean(editor && editor.offsetParent),
        editorState: editor?.dataset.state ?? null,
        editorContent: editor?.querySelector(".cm-content")?.textContent ?? "",
        wordWrap:
          editor
            ?.querySelector("[data-editor-action='wrap']")
            ?.getAttribute("aria-pressed") === "true",
        shellRuntimeId: terminalState?.runtimeId ?? null,
        browserStatus:
          browserPanel?.querySelector(".browser-state")?.textContent ?? "",
        browserNativeVisible: browserPanel?.dataset.nativeVisible === "true",
      };
    },
    { requestedFolder: folderName, requestedWorkspace: workspaceName },
  );
}

describe("Linux workspace recovery", () => {
  before(async () => {
    mkdirSync(artifactDirectory, { recursive: true });
    await browser.pause(2_000);
    await $("#app").waitForDisplayed();
  });

  it("restores Space, Folder, Editor state, Shell, and Browser after restart", async () => {
    try {
      await browser.waitUntil(
        async () => {
          const state = await recoveryState();
          return (
            state.activeName === workspaceName &&
            state.globalStatus === "ready" &&
            state.editorState === "clean" &&
            state.editorContent.includes(unicodeMarker) &&
            Boolean(state.shellRuntimeId) &&
            state.browserNativeVisible &&
            state.browserStatus.includes("ready")
          );
        },
        {
          timeout: 45_000,
          interval: 250,
          timeoutMsg: "Persisted workspace did not recover",
        },
      );
    } catch (error) {
      writeFileSync(
        join(artifactDirectory, "workspace-recovery-failure.json"),
        `${JSON.stringify(await recoveryState(), null, 2)}\n`,
      );
      await browser.saveScreenshot(
        join(artifactDirectory, "workspace-recovery-failure.png"),
      );
      throw error;
    }

    const state = await recoveryState();
    expect(state.activeRoot).toBe(fixtureRoot);
    expect(state.folderExpanded).toBe(true);
    expect(state.workspaceInsideFolder).toBe(true);
    expect(state.editorCount).toBe(1);
    expect(state.editorVisible).toBe(true);
    expect(state.wordWrap).toBe(true);
    expect(readFileSync(join(fixtureRoot, fixtureFileName), "utf8")).toContain(
      unicodeMarker,
    );

    writeFileSync(
      join(artifactDirectory, "workspace-after-restart.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    await browser.saveScreenshot(
      join(artifactDirectory, "workspace-after-restart.png"),
    );
  });
});
