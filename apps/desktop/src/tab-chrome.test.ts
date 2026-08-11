import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  ContextMenuItemConfig,
  GetTabContextMenuItemsParams,
  TabPartInitParameters,
} from "dockview";

import type { CliSessionDto } from "./generated/CliSessionDto";
import type { TabDto } from "./generated/TabDto";
import {
  createTabContextMenuItems,
  TAB_CONTEXT_MENU_LABELS,
} from "./tab-context-menu";
import {
  closeTabAfterApproval,
  requiresAgentCliCloseConfirmation,
} from "./tab-close";
import { CcsmTabRenderer, resolveTabIconKind } from "./tab-header";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();

function tab(kind: TabDto["kind"], title: string, resourceId: string): TabDto {
  return {
    id: `${kind}-${resourceId}`,
    spaceId: "space-1",
    kind,
    title,
    resourceId,
    stateVersion: 1,
    state: {},
  };
}

function session(
  id: string,
  provider: CliSessionDto["provider"],
): CliSessionDto {
  return {
    id,
    spaceId: "space-1",
    provider,
    cwd: "D:\\work",
    nativeSessionId: null,
    nativeBindingState: provider === "shell" ? "not_applicable" : "pending",
    desiredState: "running",
    lastExitSummary: null,
  };
}

function menuFixture(ids: string[]) {
  const closed: string[] = [];
  const panels = ids.map((id) => ({
    id,
    api: { close: () => closed.push(id) },
  }));
  const group = { panels };
  const params = {
    panel: panels[1] ?? panels[0],
    group,
  } as unknown as GetTabContextMenuItemsParams;
  return { closed, panels, group, params };
}

function configuredItem(
  items: ReturnType<typeof createTabContextMenuItems>,
  index: number,
): ContextMenuItemConfig {
  return items[index] as ContextMenuItemConfig;
}

describe("CCSM Tab chrome", () => {
  test("keeps icon sizing on Dockview drag ghosts outside #dockview", () => {
    expect(css).toMatch(
      /\.ccsm-tab-icon\s*\{[^}]*width:\s*14px[^}]*height:\s*14px/s,
    );
    expect(css).toMatch(
      /\.ccsm-tab-icon svg,\s*\.ccsm-tab-icon img\s*\{[^}]*width:\s*14px[^}]*height:\s*14px/s,
    );
    expect(css).not.toContain("#dockview .ccsm-tab-icon");
    expect(css).not.toContain("#dockview .ccsm-tab-label");
  });

  test("resolves stable provider and built-in Tab icons", () => {
    const sessions = [
      session("shell-1", "shell"),
      session("claude-1", "claude"),
      session("codex-1", "codex"),
    ];

    expect(
      resolveTabIconKind(tab("cli-session", "Renamed", "shell-1"), sessions),
    ).toBe("shell");
    expect(
      resolveTabIconKind(tab("cli-session", "Renamed", "claude-1"), sessions),
    ).toBe("claude");
    expect(
      resolveTabIconKind(tab("cli-session", "Renamed", "codex-1"), sessions),
    ).toBe("codex");
    expect(
      resolveTabIconKind(tab("browser", "Browser", "browser-1"), sessions),
    ).toBe("browser");
    expect(
      resolveTabIconKind(tab("file-explorer", "Files", "files-1"), sessions),
    ).toBe("files");
    expect(
      resolveTabIconKind(
        tab("file-editor", "main.ts", "src/main.ts"),
        sessions,
      ),
    ).toBe("document");
    expect(resolveTabIconKind(tab("git", "Git", "git-1"), sessions)).toBe(
      "git",
    );
  });

  test("reproduces the original menu order and group-local actions", () => {
    const fixture = menuFixture(["left", "selected", "right-1", "right-2"]);
    let opened = 0;
    const requested: string[] = [];
    const items = createTabContextMenuItems(
      fixture.params,
      () => opened++,
      (panel) => requested.push(panel.id),
    );

    expect(opened).toBe(1);
    expect(
      items
        .filter((item) => item !== "separator")
        .map((item) => (item as ContextMenuItemConfig).label),
    ).toEqual([...TAB_CONTEXT_MENU_LABELS]);
    expect(items[3]).toBe("separator");
    expect(configuredItem(items, 1).disabled).toBe(false);
    expect(configuredItem(items, 2).disabled).toBe(false);

    configuredItem(items, 2).action?.();
    expect(requested).toEqual(["right-1", "right-2"]);
    expect(fixture.closed).toEqual([]);
  });

  test("disables actions that have no target", () => {
    const fixture = menuFixture(["only"]);
    const items = createTabContextMenuItems(
      fixture.params,
      () => {},
      () => {},
    );

    expect(configuredItem(items, 1).disabled).toBe(true);
    expect(configuredItem(items, 2).disabled).toBe(true);
  });

  test("routes the Tab close button through application preflight", () => {
    const shell = tab("cli-session", "Shell", "shell-1");
    const requested: string[] = [];
    let dockviewCloseCalls = 0;
    const renderer = new CcsmTabRenderer(
      shell,
      [session("shell-1", "shell")],
      (tabId) => requested.push(tabId),
    );
    renderer.init({
      title: "Shell",
      api: {
        close: () => dockviewCloseCalls++,
        onDidTitleChange: () => ({ dispose: () => {} }),
      },
    } as unknown as TabPartInitParameters);

    renderer.element
      .querySelector<HTMLButtonElement>(".ccsm-tab-close")!
      .click();

    expect(requested).toEqual([shell.id]);
    expect(dockviewCloseCalls).toBe(0);
    renderer.dispose();
  });

  test("warns only for Claude and Codex CLI Tabs", () => {
    const sessions = [
      session("shell-1", "shell"),
      session("claude-1", "claude"),
      session("codex-1", "codex"),
    ];

    expect(
      requiresAgentCliCloseConfirmation(
        tab("cli-session", "Shell", "shell-1"),
        sessions,
      ),
    ).toBe(false);
    expect(
      requiresAgentCliCloseConfirmation(
        tab("cli-session", "Claude", "claude-1"),
        sessions,
      ),
    ).toBe(true);
    expect(
      requiresAgentCliCloseConfirmation(
        tab("cli-session", "Codex", "codex-1"),
        sessions,
      ),
    ).toBe(true);
    expect(
      requiresAgentCliCloseConfirmation(
        tab("browser", "Codex docs", "browser-1"),
        sessions,
      ),
    ).toBe(false);
  });

  test("keeps an Agent panel mounted until close confirmation resolves", async () => {
    let resolveConfirmation: (confirmed: boolean) => void = () => {};
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    let closeCalls = 0;
    const close = closeTabAfterApproval(
      tab("cli-session", "Codex", "codex-1"),
      {
        cliSessions: [session("codex-1", "codex")],
        confirmAgentCli: () => confirmation,
        confirmFileEditor: async () => true,
        closePanel: () => {
          closeCalls++;
          return true;
        },
      },
    );

    await Promise.resolve();
    expect(closeCalls).toBe(0);
    resolveConfirmation(false);
    await expect(close).resolves.toBe(false);
    expect(closeCalls).toBe(0);
  });

  test("closes a normal Shell immediately without Agent confirmation", async () => {
    let confirmationCalls = 0;
    let closeCalls = 0;

    await expect(
      closeTabAfterApproval(tab("cli-session", "Shell", "shell-1"), {
        cliSessions: [session("shell-1", "shell")],
        confirmAgentCli: async () => {
          confirmationCalls++;
          return false;
        },
        confirmFileEditor: async () => true,
        closePanel: () => {
          closeCalls++;
          return true;
        },
      }),
    ).resolves.toBe(true);
    expect(confirmationCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });
});
