import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const phase = process.env.CCSM_E2E_HANG_STRESS_PHASE;
const enabled =
  phase === "prepare" || phase === "setup" || phase === "editor-tabs";
const prepareIt = phase === "prepare" ? it : it.skip;
const stressIt = phase === "setup" ? it : it.skip;
const editorIt = phase === "editor-tabs" ? it : it.skip;
const artifactDirectory = process.env.CCSM_E2E_ARTIFACT_DIR!;
const fixtureRoot = process.env.CCSM_E2E_FIXTURE_ROOT ?? ".";
const editorDirectory = join(fixtureRoot, "000-editor");
const bigFilePath = "000-editor/000-big.txt";
const bigFileBytes = 5 * 1024 * 1024 - 4_096;
const editorTabCount = 60;

interface TerminalStressSnapshot {
  runtimeId: string | null;
  provider: string | null;
  inputEnabled: boolean;
  queuedOutputBytes: number;
  outputWriteCreditBytes: number;
  pendingOutputAckBytes: number;
  text: string;
}

function writeEvidence(name: string, value: unknown): void {
  writeFileSync(
    join(artifactDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function createFixture(): void {
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(editorDirectory, { recursive: true });
  writeFileSync(join(fixtureRoot, "baseline.txt"), "baseline\n");
  execFileSync("git", ["init", "-b", "main"], {
    cwd: fixtureRoot,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "CCSM stress"], {
    cwd: fixtureRoot,
  });
  execFileSync("git", ["config", "user.email", "stress@example.invalid"], {
    cwd: fixtureRoot,
  });
  execFileSync("git", ["add", "baseline.txt"], { cwd: fixtureRoot });
  execFileSync("git", ["commit", "-m", "baseline"], {
    cwd: fixtureRoot,
    stdio: "ignore",
  });
  writeFileSync(
    join(fixtureRoot, "000-huge-diff.ts"),
    Array.from(
      { length: 40_000 },
      (_, index) => `export const stress_${index} = ${index};\n`,
    ).join(""),
  );
  writeFileSync(join(editorDirectory, "000-big.txt"), "x".repeat(bigFileBytes));
  for (let index = 1; index <= editorTabCount; index += 1) {
    writeFileSync(
      join(editorDirectory, `tab-${String(index).padStart(3, "0")}.txt`),
      `tab ${index}\n`,
    );
  }
  for (let index = 0; index < 1_200; index += 1) {
    mkdirSync(
      join(fixtureRoot, `stress-dir-${String(index).padStart(4, "0")}`),
    );
  }
}

async function ensureStressViewport(): Promise<void> {
  await browser.setWindowSize(1_439, 899);
  await browser.setWindowSize(1_440, 900);
  await browser.waitUntil(
    () =>
      browser.execute(
        () => window.innerWidth >= 1_000 && window.innerHeight >= 700,
      ),
    {
      timeout: 15_000,
      timeoutMsg: "stress application viewport did not reach a usable size",
    },
  );
}

async function setPickerPath(path: string): Promise<void> {
  await browser.execute((requestedPath) => {
    const input =
      document.querySelector<HTMLInputElement>(".directory-address");
    if (!input) throw new Error("directory address is missing");
    input.value = requestedPath;
    input
      .closest<HTMLFormElement>("form")
      ?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
  }, path);
}

async function activateTab(kind: string): Promise<void> {
  const selectors: Record<string, string> = {
    "cli-session": ".terminal-panel",
    "file-explorer": ".file-explorer-panel",
    "file-editor": ".file-editor-panel",
    git: ".git-panel",
  };
  const selector = selectors[kind];
  if (!selector) throw new Error(`unknown Tab kind: ${kind}`);
  const tabId = await browser.execute((requestedKind) => {
    const tab = Array.from(
      document.querySelectorAll<HTMLElement>(
        `.ccsm-tab[data-tab-kind='${CSS.escape(requestedKind)}']`,
      ),
    ).find((candidate) => !candidate.closest(".dv-tabs-overflow-container"));
    const target = tab?.closest<HTMLElement>(".dv-tab") ?? tab;
    if (!target || !tab?.dataset.tabId) return null;
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    target.focus();
    target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 8172,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 1,
      }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    return tab.dataset.tabId;
  }, kind);
  expect(tabId).not.toBeNull();
  await browser.waitUntil(
    () =>
      browser.execute((requestedTabId) => {
        const snapshot = window.__CCSM_DEBUG__.snapshot() as {
          panels?: Array<{ id: string; active: boolean }>;
        };
        return snapshot.panels?.some(
          (panel) => panel.id === requestedTabId && panel.active,
        );
      }, tabId),
    {
      timeout: 30_000,
      timeoutMsg: `${kind} Tab did not become active`,
    },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        ({ requestedTabId, requestedSelector }) =>
          Boolean(
            document
              .querySelector(
                `.deferred-tab-renderer[data-tab-id='${CSS.escape(requestedTabId!)}']`,
              )
              ?.querySelector(requestedSelector),
          ),
        { requestedTabId: tabId, requestedSelector: selector },
      ),
    {
      timeout: 30_000,
      timeoutMsg: `${kind} panel did not materialize`,
    },
  );
}

async function startHeartbeat(): Promise<void> {
  await browser.execute(() => {
    const target = window as Window & {
      __CCSM_STRESS_TIMER__?: number;
      __CCSM_STRESS_HEARTBEAT__?: number;
    };
    if (target.__CCSM_STRESS_TIMER__)
      window.clearInterval(target.__CCSM_STRESS_TIMER__);
    target.__CCSM_STRESS_HEARTBEAT__ = 0;
    target.__CCSM_STRESS_TIMER__ = window.setInterval(() => {
      target.__CCSM_STRESS_HEARTBEAT__ =
        (target.__CCSM_STRESS_HEARTBEAT__ ?? 0) + 1;
    }, 10);
  });
}

async function heartbeat(): Promise<number> {
  return browser.execute(
    () =>
      (window as Window & { __CCSM_STRESS_HEARTBEAT__?: number })
        .__CCSM_STRESS_HEARTBEAT__ ?? 0,
  );
}

async function terminalSnapshot(): Promise<TerminalStressSnapshot | null> {
  return browser.execute(() => {
    for (const panel of document.querySelectorAll<HTMLElement>(
      ".terminal-panel",
    )) {
      const snapshot = (
        panel as HTMLElement & {
          __CCSM_TERMINAL_DEBUG__?: () => TerminalStressSnapshot;
        }
      ).__CCSM_TERMINAL_DEBUG__?.();
      if (snapshot?.provider === "shell") return snapshot;
    }
    return null;
  });
}

async function ensureShellRuntime(): Promise<void> {
  await browser.waitUntil(
    async () => Boolean((await terminalSnapshot())?.inputEnabled),
    {
      timeout: 30_000,
      timeoutMsg: "Shell terminal did not become interactive",
    },
  );
  if (!(await terminalSnapshot())?.runtimeId) {
    expect(
      await browser.execute(() => {
        for (const panel of document.querySelectorAll<HTMLElement>(
          ".terminal-panel",
        )) {
          const snapshot = (
            panel as HTMLElement & {
              __CCSM_TERMINAL_DEBUG__?: () => TerminalStressSnapshot;
            }
          ).__CCSM_TERMINAL_DEBUG__?.();
          if (snapshot?.provider !== "shell") continue;
          const action =
            panel.querySelector<HTMLButtonElement>(".terminal-action");
          action?.click();
          return Boolean(action);
        }
        return false;
      }),
    ).toBe(true);
  }
  await browser.waitUntil(
    async () => Boolean((await terminalSnapshot())?.runtimeId),
    {
      timeout: 30_000,
      timeoutMsg: "Shell runtime did not start",
    },
  );
}

async function sendShellInput(text: string, enter = true): Promise<void> {
  const sent = await browser.execute(
    ({ input, submit }) => {
      for (const panel of document.querySelectorAll<HTMLElement>(
        ".terminal-panel",
      )) {
        const snapshot = (
          panel as HTMLElement & {
            __CCSM_TERMINAL_DEBUG__?: () => TerminalStressSnapshot;
          }
        ).__CCSM_TERMINAL_DEBUG__?.();
        if (snapshot?.provider !== "shell" || !snapshot.inputEnabled) continue;
        const host = panel.querySelector<HTMLElement>(".terminal-host");
        if (!host) return false;
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", input);
        host.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        );
        if (submit) {
          host.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        return true;
      }
      return false;
    },
    { input: text, submit: enter },
  );
  expect(sent).toBe(true);
}

async function interruptShell(): Promise<void> {
  expect(
    await browser.execute(() => {
      for (const panel of document.querySelectorAll<HTMLElement>(
        ".terminal-panel",
      )) {
        const host = panel.querySelector<HTMLElement>(".terminal-host");
        const debug = (
          panel as HTMLElement & {
            __CCSM_TERMINAL_DEBUG__?: () => TerminalStressSnapshot;
          }
        ).__CCSM_TERMINAL_DEBUG__?.();
        if (debug?.provider !== "shell" || !host) continue;
        host.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "c",
            code: "KeyC",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      }
      return false;
    }),
  ).toBe(true);
}

(enabled ? describe : describe.skip)("hang-resilience stress setup", () => {
  before(async () => {
    if (phase === "prepare") createFixture();
    else mkdirSync(artifactDirectory, { recursive: true });
    await ensureStressViewport();
    await $("#app").waitForDisplayed({ timeout: 30_000 });
    if (phase === "setup" || phase === "editor-tabs") {
      await browser.waitUntil(
        () =>
          browser.execute(
            () =>
              document.querySelector("#active-space-name")?.textContent ===
                "Hang Stress" &&
              document.querySelector("#global-status")?.textContent === "ready",
          ),
        {
          timeout: 45_000,
          timeoutMsg: "prepared stress Space did not recover",
        },
      );
    }
  });

  prepareIt(
    "paginates and cancels rapid host-directory navigation",
    async () => {
      await ensureStressViewport();
      await $("#new-space").click();
      await $(".directory-dialog").waitForDisplayed();
      await startHeartbeat();
      await setPickerPath(fixtureRoot);
      await setPickerPath(editorDirectory);
      await browser.waitUntil(
        async () =>
          (await $(".directory-address").getValue()) === editorDirectory,
        {
          timeout: 20_000,
          timeoutMsg: "rapid picker navigation did not settle",
        },
      );
      await setPickerPath(fixtureRoot);
      await browser.waitUntil(
        async () => (await $$(".directory-row")).length === 200,
        {
          timeout: 20_000,
          timeoutMsg: "directory picker page was not bounded",
        },
      );
      await $(".directory-load-more").click();
      await browser.waitUntil(
        async () =>
          (await $(".directory-page-previous").isExisting()) &&
          (await $$(".directory-row")).length === 200,
        {
          timeout: 20_000,
          timeoutMsg: "directory picker second page was not bounded",
        },
      );
      const secondPageRenderedRows = (await $$(".directory-row")).length;
      await $(".directory-page-previous").click();
      await browser.waitUntil(
        async () =>
          !(await $(".directory-page-previous").isExisting()) &&
          (await $$(".directory-row")).length === 200,
        {
          timeout: 20_000,
          timeoutMsg:
            "directory picker did not return to its bounded first page",
        },
      );
      const pickerEvidence = {
        renderedRows: (await $$(".directory-row")).length,
        secondPageRenderedRows,
        returnedPageRenderedRows: (await $$(".directory-row")).length,
        hasMore: await $(".directory-load-more").isExisting(),
        heartbeat: await heartbeat(),
        finalPath: await $(".directory-address").getValue(),
      };
      expect(pickerEvidence.renderedRows).toBe(200);
      expect(pickerEvidence.secondPageRenderedRows).toBe(200);
      expect(pickerEvidence.returnedPageRenderedRows).toBe(200);
      expect(pickerEvidence.hasMore).toBe(true);
      expect(pickerEvidence.heartbeat).toBeGreaterThan(0);
      writeEvidence("stress-directory-picker.json", pickerEvidence);

      await $(".directory-use").click();
      await $(".app-dialog").waitForDisplayed();
      await $(".app-dialog-field input").setValue("Hang Stress");
      await $("[data-dialog-action='submit']").click();
      await browser.waitUntil(
        () =>
          browser.execute((rootPath) => {
            const snapshot = window.__CCSM_DEBUG__.snapshot() as {
              activeSpaceId?: string;
              spaces?: Array<{ id: string; rootPath: string }>;
            };
            return (
              snapshot.spaces?.find(
                (space) => space.id === snapshot.activeSpaceId,
              )?.rootPath === rootPath
            );
          }, fixtureRoot),
        { timeout: 45_000, timeoutMsg: "stress Space did not become ready" },
      );
      writeEvidence("stress-space-created.json", {
        activeSpace: await $("#active-space-name").getText(),
        globalStatus: await $("#global-status").getText(),
        snapshot: await browser.execute(() => window.__CCSM_DEBUG__.snapshot()),
      });
    },
  );

  stressIt(
    "keeps Explorer DOM bounded while paging a 1,200-directory root",
    async () => {
      await ensureStressViewport();
      await activateTab("file-explorer");
      const tree = await $(".file-explorer-panel .files-tree");
      await browser.waitUntil(
        async () => Number(await tree.getAttribute("data-total-items")) >= 201,
        { timeout: 20_000, timeoutMsg: "Explorer first page did not load" },
      );
      for (let page = 1; page < 10; page += 1) {
        const previousTotal = Number(
          await tree.getAttribute("data-total-items"),
        );
        await browser.execute(() => {
          const tree = document.querySelector<HTMLElement>(
            ".file-explorer-panel .files-tree",
          );
          if (!tree) return;
          tree.scrollTop = tree.scrollHeight;
          tree.dispatchEvent(new Event("scroll"));
        });
        await browser.pause(200);
        const loadMore = await $(".file-load-more");
        if (!(await loadMore.isExisting())) break;
        expect(
          await browser.execute(() => {
            const button =
              document.querySelector<HTMLButtonElement>(".file-load-more");
            button?.click();
            return Boolean(button);
          }),
        ).toBe(true);
        await browser.waitUntil(
          async () =>
            Number(await tree.getAttribute("data-total-items")) > previousTotal,
          {
            timeout: 20_000,
            timeoutMsg: `Explorer page ${page + 1} did not load`,
          },
        );
      }
      const evidence = {
        modelItems: Number(await tree.getAttribute("data-total-items")),
        renderedItems: Number(await tree.getAttribute("data-rendered-items")),
        domRows: (await $$(".file-explorer-panel .file-row")).length,
      };
      expect(evidence.modelItems).toBeGreaterThanOrEqual(1_001);
      expect(evidence.renderedItems).toBeGreaterThan(0);
      expect(evidence.renderedItems).toBeLessThanOrEqual(100);
      expect(evidence.domRows).toBeGreaterThan(0);
      expect(evidence.domRows).toBeLessThanOrEqual(100);
      writeEvidence("stress-explorer-pagination.json", evidence);
    },
  );

  stressIt(
    "renders a 40,000-line Git diff through a bounded row window",
    async () => {
      await ensureStressViewport();
      await activateTab("git");
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const bounds = document
              .querySelector<HTMLElement>(".git-diff-pane")
              ?.getBoundingClientRect();
            return Boolean(bounds && bounds.width > 100 && bounds.height > 100);
          }),
        {
          timeout: 15_000,
          timeoutMsg: "Git diff pane did not receive the stress viewport",
        },
      );
      await startHeartbeat();
      const refreshTarget = await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>(".git-panel");
        const previousRevision = Number(panel?.dataset.refreshRevision ?? 0);
        const wasScanning = panel?.dataset.scanState === "scanning";
        const refresh =
          document.querySelector<HTMLButtonElement>(".git-refresh");
        refresh?.click();
        return refresh
          ? {
              revision: previousRevision + (wasScanning ? 2 : 1),
            }
          : null;
      });
      expect(refreshTarget).not.toBeNull();
      await browser.waitUntil(
        () =>
          browser.execute((target) => {
            const panel = document.querySelector<HTMLElement>(".git-panel");
            const status =
              document.querySelector(".git-status")?.textContent ?? "";
            return (
              Number(panel?.dataset.refreshRevision ?? 0) >= target!.revision &&
              panel?.dataset.scanState === "idle" &&
              status.includes("repos") &&
              status.includes("changes")
            );
          }, refreshTarget),
        {
          timeout: 45_000,
          interval: 100,
          timeoutMsg: "Git refresh revision did not settle",
        },
      );
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                ".git-navigation-file",
              ),
            ).find((candidate) =>
              candidate.title.startsWith("000-huge-diff.ts"),
            );
            button?.click();
            return Boolean(button?.classList.contains("is-selected"));
          }),
        {
          timeout: 30_000,
          interval: 100,
          timeoutMsg: "huge diff navigation did not become selected",
        },
      );
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            Array.from(
              document.querySelectorAll<HTMLElement>(".git-diff-file"),
            ).some((file) => Number(file.dataset.totalRows ?? 0) >= 40_000),
          ),
        {
          timeout: 45_000,
          interval: 200,
          timeoutMsg: "huge Git diff did not load",
        },
      );
      try {
        await browser.waitUntil(
          () =>
            browser.execute(() =>
              Array.from(
                document.querySelectorAll<HTMLElement>(".git-diff-file"),
              ).some(
                (file) =>
                  Number(file.dataset.totalRows ?? 0) >= 40_000 &&
                  Number(file.dataset.renderedRows ?? 0) > 0,
              ),
            ),
          {
            timeout: 5_000,
            interval: 50,
            timeoutMsg: "huge Git diff row window did not mount",
          },
        );
      } catch (error) {
        const diagnostic = await browser.execute(() => {
          const pane = document.querySelector<HTMLElement>(".git-diff-pane");
          const target = Array.from(
            document.querySelectorAll<HTMLElement>(".git-diff-file"),
          ).find((file) => Number(file.dataset.totalRows ?? 0) >= 40_000);
          const body = target?.querySelector<HTMLElement>(
            ".git-diff-file-body",
          );
          const rectangle = (element: Element | null | undefined) => {
            const bounds = element?.getBoundingClientRect();
            return bounds
              ? {
                  top: bounds.top,
                  right: bounds.right,
                  bottom: bounds.bottom,
                  left: bounds.left,
                  width: bounds.width,
                  height: bounds.height,
                }
              : null;
          };
          return {
            pane: {
              bounds: rectangle(pane),
              scrollTop: pane?.scrollTop ?? null,
              scrollHeight: pane?.scrollHeight ?? null,
              clientHeight: pane?.clientHeight ?? null,
            },
            target: {
              bounds: rectangle(target),
              bodyBounds: rectangle(body),
              hidden: target?.hidden ?? null,
              bodyHidden: body?.hidden ?? null,
              totalRows: target?.dataset.totalRows ?? null,
              renderedRows: target?.dataset.renderedRows ?? null,
              bodyDisplay: body ? getComputedStyle(body).display : null,
            },
            activeTitle: document
              .querySelector(".git-navigation-file.is-selected")
              ?.getAttribute("title"),
            debug: (
              document.querySelector(".git-panel") as HTMLElement & {
                __CCSM_GIT_DEBUG__?: () => unknown;
              }
            )?.__CCSM_GIT_DEBUG__?.(),
          };
        });
        writeEvidence("stress-git-diagnostic.json", diagnostic);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
        );
      }
      const evidence = await browser.execute(() => {
        const file = Array.from(
          document.querySelectorAll<HTMLElement>(".git-diff-file"),
        ).find(
          (candidate) => Number(candidate.dataset.totalRows ?? 0) >= 40_000,
        );
        return {
          paneWidth:
            document
              .querySelector<HTMLElement>(".git-diff-pane")
              ?.getBoundingClientRect().width ?? 0,
          paneHeight:
            document
              .querySelector<HTMLElement>(".git-diff-pane")
              ?.getBoundingClientRect().height ?? 0,
          totalRows: Number(file?.dataset.totalRows ?? 0),
          fileRenderedRows: Number(file?.dataset.renderedRows ?? 0),
          allDiffDomRows: document.querySelectorAll(".git-diff-row").length,
          heartbeat:
            (window as Window & { __CCSM_STRESS_HEARTBEAT__?: number })
              .__CCSM_STRESS_HEARTBEAT__ ?? 0,
        };
      });
      expect(evidence.paneWidth).toBeGreaterThan(100);
      expect(evidence.paneHeight).toBeGreaterThan(100);
      expect(evidence.totalRows).toBeGreaterThanOrEqual(40_000);
      expect(evidence.fileRenderedRows).toBeGreaterThan(0);
      expect(evidence.fileRenderedRows).toBeLessThanOrEqual(150);
      expect(evidence.allDiffDomRows).toBeGreaterThan(0);
      expect(evidence.allDiffDomRows).toBeLessThanOrEqual(250);
      expect(evidence.heartbeat).toBeGreaterThan(0);
      writeEvidence("stress-git-diff.json", evidence);
    },
  );

  editorIt(
    "edits a near-limit 5 MiB document while the renderer heartbeat advances",
    async () => {
      await ensureStressViewport();
      const openResult = await browser.executeAsync((relativePath, done) => {
        window.__CCSM_DEBUG__.app
          .debugOpenFileEditors([relativePath])
          .then(() => done({ ok: true, message: "" }))
          .catch((error: unknown) =>
            done({
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
      }, bigFilePath);
      expect(openResult).toEqual({ ok: true, message: "" });
      try {
        await browser.waitUntil(
          () =>
            browser.execute(
              ({ relativePath, expectedLength }) => {
                const snapshot = window.__CCSM_DEBUG__.snapshot() as {
                  tabs?: Array<{
                    id: string;
                    kind: string;
                    resourceId?: string | null;
                  }>;
                  panels?: Array<{ id: string; active: boolean }>;
                };
                const tab = snapshot.tabs?.find(
                  (candidate) =>
                    candidate.kind === "file-editor" &&
                    candidate.resourceId === relativePath,
                );
                if (
                  !tab ||
                  !snapshot.panels?.some(
                    (panel) => panel.id === tab.id && panel.active,
                  )
                ) {
                  return false;
                }
                const editor = document.querySelector<HTMLElement>(
                  `.deferred-tab-renderer[data-tab-id='${CSS.escape(tab.id)}'] .file-editor-panel`,
                );
                return (
                  editor?.dataset.state === "clean" &&
                  Number(editor.dataset.documentLength) === expectedLength
                );
              },
              { relativePath: bigFilePath, expectedLength: bigFileBytes },
            ),
          { timeout: 45_000, timeoutMsg: "large editor did not load" },
        );
      } catch (error) {
        const diagnostic = await browser.execute((relativePath) => {
          const snapshot = window.__CCSM_DEBUG__.snapshot() as {
            tabs?: Array<{
              id: string;
              kind: string;
              resourceId?: string | null;
            }>;
            panels?: Array<{ id: string; active: boolean }>;
          };
          const tab = snapshot.tabs?.find(
            (candidate) =>
              candidate.kind === "file-editor" &&
              candidate.resourceId === relativePath,
          );
          const wrapper = tab
            ? document.querySelector<HTMLElement>(
                `.deferred-tab-renderer[data-tab-id='${CSS.escape(tab.id)}']`,
              )
            : null;
          const editor =
            wrapper?.querySelector<HTMLElement>(".file-editor-panel");
          const bounds = editor?.getBoundingClientRect();
          const debug = (
            editor as HTMLElement & {
              __CCSM_FILE_EDITOR_DEBUG__?: () => unknown;
            }
          )?.__CCSM_FILE_EDITOR_DEBUG__?.();
          return {
            tab,
            active: tab
              ? snapshot.panels?.some(
                  (panel) => panel.id === tab.id && panel.active,
                )
              : false,
            wrapper: wrapper
              ? {
                  connected: wrapper.isConnected,
                  error: wrapper.dataset.error ?? null,
                  text: wrapper.textContent?.slice(0, 500) ?? null,
                }
              : null,
            editor: editor
              ? {
                  state: editor.dataset.state ?? null,
                  documentLength: editor.dataset.documentLength ?? null,
                  width: bounds?.width ?? null,
                  height: bounds?.height ?? null,
                  status:
                    editor.querySelector(".file-editor-status")?.textContent ??
                    null,
                  banner:
                    editor.querySelector(".file-editor-banner")?.textContent ??
                    null,
                  debug,
                }
              : null,
            tabRestore: (
              window.__CCSM_DEBUG__.snapshot() as { tabRestore?: unknown }
            ).tabRestore,
            globalStatus:
              document.querySelector("#global-status")?.textContent ?? null,
          };
        }, bigFilePath);
        writeEvidence("stress-large-editor-diagnostic.json", diagnostic);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`,
        );
      }
      const initialLength = await browser.execute((relativePath) => {
        const snapshot = window.__CCSM_DEBUG__.snapshot() as {
          tabs?: Array<{
            id: string;
            kind: string;
            resourceId?: string | null;
          }>;
        };
        const tab = snapshot.tabs?.find(
          (candidate) =>
            candidate.kind === "file-editor" &&
            candidate.resourceId === relativePath,
        );
        const editor = tab
          ? document.querySelector<HTMLElement>(
              `.deferred-tab-renderer[data-tab-id='${CSS.escape(tab.id)}'] .file-editor-panel`,
            )
          : null;
        return Number(editor?.dataset.documentLength ?? 0);
      }, bigFilePath);
      expect(initialLength).toBe(bigFileBytes);
      await startHeartbeat();
      const started = Date.now();
      const inputResult = await browser.executeAsync(
        ({ count, relativePath }, done) => {
          const snapshot = window.__CCSM_DEBUG__.snapshot() as {
            tabs?: Array<{
              id: string;
              kind: string;
              resourceId?: string | null;
            }>;
          };
          const tab = snapshot.tabs?.find(
            (candidate) =>
              candidate.kind === "file-editor" &&
              candidate.resourceId === relativePath,
          );
          const panel = tab
            ? document.querySelector<HTMLElement>(
                `.deferred-tab-renderer[data-tab-id='${CSS.escape(tab.id)}'] .file-editor-panel`,
              )
            : null;
          const debug = (
            panel as HTMLElement & {
              __CCSM_FILE_EDITOR_DEBUG__?: () => {
                documentLength: number;
                insertText(text: string): boolean;
              };
            }
          )?.__CCSM_FILE_EDITOR_DEBUG__?.();
          if (!debug) {
            done({ ok: false, documentLength: 0 });
            return;
          }
          let inserted = 0;
          const step = () => {
            for (let batch = 0; batch < 8 && inserted < count; batch += 1) {
              if (!debug.insertText("Z")) {
                done({ ok: false, documentLength: debug.documentLength });
                return;
              }
              inserted += 1;
            }
            if (inserted < count) window.setTimeout(step, 0);
            else done({ ok: true, documentLength: debug.documentLength });
          };
          step();
        },
        { count: 256, relativePath: bigFilePath },
      );
      const durationMs = Date.now() - started;
      expect(inputResult.ok).toBe(true);
      await browser.waitUntil(
        () =>
          browser.execute(
            ({ relativePath, expectedLength }) => {
              const snapshot = window.__CCSM_DEBUG__.snapshot() as {
                tabs?: Array<{
                  id: string;
                  kind: string;
                  resourceId?: string | null;
                }>;
              };
              const tab = snapshot.tabs?.find(
                (candidate) =>
                  candidate.kind === "file-editor" &&
                  candidate.resourceId === relativePath,
              );
              const editor = tab
                ? document.querySelector<HTMLElement>(
                    `.deferred-tab-renderer[data-tab-id='${CSS.escape(tab.id)}'] .file-editor-panel`,
                  )
                : null;
              return (
                Number(editor?.dataset.documentLength ?? 0) === expectedLength
              );
            },
            {
              relativePath: bigFilePath,
              expectedLength: initialLength + 256,
            },
          ),
        { timeout: 15_000, timeoutMsg: "large editor input was not applied" },
      );
      const finalLength = await browser.execute((relativePath) => {
        const snapshot = window.__CCSM_DEBUG__.snapshot() as {
          tabs?: Array<{
            id: string;
            kind: string;
            resourceId?: string | null;
          }>;
        };
        const tab = snapshot.tabs?.find(
          (candidate) =>
            candidate.kind === "file-editor" &&
            candidate.resourceId === relativePath,
        );
        const editor = tab
          ? document.querySelector<HTMLElement>(
              `.deferred-tab-renderer[data-tab-id='${CSS.escape(tab.id)}'] .file-editor-panel`,
            )
          : null;
        return Number(editor?.dataset.documentLength ?? 0);
      }, bigFilePath);
      const evidence = {
        initialLength,
        finalLength,
        inputCharacters: 256,
        durationMs,
        heartbeat: await heartbeat(),
      };
      expect(evidence.durationMs).toBeLessThan(10_000);
      expect(evidence.heartbeat).toBeGreaterThan(0);
      writeEvidence("stress-large-editor.json", evidence);
    },
  );

  stressIt(
    "bounds continuous PTY output and stops an uncooperative process on deadline",
    async () => {
      await ensureStressViewport();
      await activateTab("cli-session");
      await ensureShellRuntime();
      await startHeartbeat();
      await sendShellInput("yes PTY_STRESS");
      let maxBufferedBytes = 0;
      for (let sample = 0; sample < 25; sample += 1) {
        await browser.pause(100);
        const snapshot = await terminalSnapshot();
        if (!snapshot) continue;
        maxBufferedBytes = Math.max(
          maxBufferedBytes,
          snapshot.queuedOutputBytes +
            snapshot.outputWriteCreditBytes +
            snapshot.pendingOutputAckBytes,
        );
      }
      await interruptShell();
      const outputEvidence = {
        maxBufferedBytes,
        creditLimitBytes: 512 * 1024,
        heartbeat: await heartbeat(),
        runtimeAlive: Boolean((await terminalSnapshot())?.runtimeId),
      };
      expect(outputEvidence.maxBufferedBytes).toBeLessThanOrEqual(600 * 1024);
      expect(outputEvidence.heartbeat).toBeGreaterThan(20);
      expect(outputEvidence.runtimeAlive).toBe(true);
      writeEvidence("stress-pty-backpressure.json", outputEvidence);

      await browser.pause(300);
      await sendShellInput("trap '' TERM; sleep 600");
      await browser.pause(300);
      await startHeartbeat();
      const stopStarted = Date.now();
      await browser.execute(() => {
        const panel = Array.from(
          document.querySelectorAll<HTMLElement>(".terminal-panel"),
        ).find((candidate) => {
          const debug = (
            candidate as HTMLElement & {
              __CCSM_TERMINAL_DEBUG__?: () => TerminalStressSnapshot;
            }
          ).__CCSM_TERMINAL_DEBUG__?.();
          return debug?.provider === "shell";
        });
        panel?.querySelector<HTMLButtonElement>(".terminal-action")?.click();
      });
      await browser.waitUntil(
        async () => (await terminalSnapshot())?.runtimeId === null,
        {
          timeout: 8_000,
          interval: 100,
          timeoutMsg: "bounded runtime stop timed out",
        },
      );
      const stopEvidence = {
        stopDurationMs: Date.now() - stopStarted,
        joinDeadlineMs: 3_000,
        heartbeat: await heartbeat(),
      };
      expect(stopEvidence.stopDurationMs).toBeLessThan(7_000);
      expect(stopEvidence.heartbeat).toBeGreaterThan(0);
      writeEvidence("stress-blocking-command-stop.json", stopEvidence);
    },
  );

  editorIt(
    "persists sixty editor Tabs for cold-restore verification",
    async () => {
      await ensureStressViewport();
      const paths = Array.from(
        { length: editorTabCount },
        (_, index) =>
          `000-editor/tab-${String(index + 1).padStart(3, "0")}.txt`,
      );
      const result = await browser.executeAsync((relativePaths, done) => {
        window.__CCSM_DEBUG__.app
          .debugOpenFileEditors(relativePaths)
          .then(() => done({ ok: true, message: "" }))
          .catch((error: unknown) =>
            done({
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
      }, paths);
      expect(result).toEqual({ ok: true, message: "" });
      await browser.waitUntil(
        async () =>
          (await $$(".ccsm-tab[data-tab-kind='file-editor']")).length ===
          editorTabCount + 1,
        { timeout: 30_000, timeoutMsg: "editor Tabs were not all created" },
      );
      await browser.execute(() => window.__CCSM_DEBUG__.app.flushLayout());
      const snapshot = await browser.execute(() =>
        window.__CCSM_DEBUG__.snapshot(),
      );
      const tabCount = (snapshot as { tabs?: unknown[] }).tabs?.length ?? 0;
      const editorCount = await $$(".ccsm-tab[data-tab-kind='file-editor']");
      expect(editorCount.length).toBe(editorTabCount + 1);
      writeEvidence("stress-tabs-before-restart.json", {
        totalTabs: tabCount,
        editorTabs: editorCount.length,
        snapshot,
      });
    },
  );
});
