import { DockviewComponent, type SerializedDockview } from "dockview";
import "dockview/dist/styles/dockview.css";

import { AgentListView } from "./agent-list";
import type { AgentSummaryDto } from "./generated/AgentSummaryDto";
import type { BootstrapDto } from "./generated/BootstrapDto";
import { DirectoryPickerDialog } from "./directory-picker";
import {
  BROWSER_POPUP_DOCK_DIRECTION,
  DOCKVIEW_DND_STRATEGY,
  findDockPanelById,
  findRestoredActivePanel,
  findSourceBrowserTab,
  findVisibleDockPanelIds,
  shouldDeleteRemovedTab,
} from "./dock-behavior";
import type { ProviderKind } from "./generated/ProviderKind";
import type { SpaceSnapshotDto } from "./generated/SpaceSnapshotDto";
import type { TabDto } from "./generated/TabDto";
import { NEW_TAB_ACTIONS, type NewTabAction } from "./new-tab-actions";
import { SpaceTreeView } from "./space-tree";
import { SurfaceOcclusionController } from "./surface-occlusion";
import { createTabContextMenuItems } from "./tab-context-menu";
import { CcsmTabRenderer } from "./tab-header";
import { BrowserTabProvider } from "./tabs/browser-provider";
import { FileExplorerTabProvider } from "./tabs/file-explorer-provider";
import { GitTabProvider } from "./tabs/git-provider";
import { TabProviderRegistry } from "./tabs/registry";
import { TerminalTabProvider } from "./tabs/terminal-provider";
import { type ThemeController, updateThemeButton } from "./theme";
import { describeError, desktopClient } from "./transport/desktop-client";
import { bindWindowChrome } from "./window-chrome";

export class CcsmApp {
  readonly #dockview: DockviewComponent;
  readonly #registry = new TabProviderRegistry();
  readonly #browserProvider: BrowserTabProvider;
  readonly #terminalProvider: TerminalTabProvider;
  readonly #surfaceOcclusion: SurfaceOcclusionController;
  readonly #directoryPicker = new DirectoryPickerDialog(
    desktopClient.directories,
  );
  readonly #agentList: AgentListView;
  readonly #tabs = new Map<string, TabDto>();
  readonly #spaceTree: SpaceTreeView;
  #bootstrap: BootstrapDto | null = null;
  #activeSnapshot: SpaceSnapshotDto | null = null;
  #layoutRevision = 0;
  #saveTimer: number | null = null;
  #restoring = false;
  #dockDragActive = false;
  #tabContextMenuObserver: MutationObserver | null = null;
  #tabContextMenuToken = 0;
  #eventUnlisten: (() => void) | null = null;
  #tabDeletionQueue: Promise<void> = Promise.resolve();
  readonly #pendingTabDeletions = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly theme: ThemeController,
  ) {
    bindWindowChrome(root, desktopClient.windowChrome);
    this.#terminalProvider = new TerminalTabProvider(
      desktopClient,
      theme.current,
    );
    const themeButton = requiredElement<HTMLButtonElement>(
      root,
      "#theme-toggle",
    );
    updateThemeButton(themeButton, theme.current);
    themeButton.addEventListener("click", () => theme.toggle());
    theme.subscribe((nextTheme) => {
      updateThemeButton(themeButton, nextTheme);
      this.#terminalProvider.setTheme(nextTheme);
      void desktopClient.windowChrome.setTheme(nextTheme).catch((error) => {
        this.#setGlobalStatus("error", `theme · ${describeError(error)}`);
      });
    });
    this.#agentList = new AgentListView(root, {
      focusAgent: (agent) => this.#focusAgent(agent),
    });
    this.#registry.register(this.#terminalProvider);
    this.#browserProvider = new BrowserTabProvider(desktopClient);
    this.#surfaceOcclusion = new SurfaceOcclusionController((occluded) =>
      this.#browserProvider.setOverlaySuspended(occluded),
    );
    this.#registry.register(this.#browserProvider);
    this.#registry.register(new FileExplorerTabProvider(desktopClient));
    this.#registry.register(new GitTabProvider(desktopClient));
    const dockRoot = requiredElement<HTMLElement>(root, "#dockview");
    this.#dockview = new DockviewComponent(dockRoot, {
      createComponent: ({ id }) => {
        const tab = this.#tabs.get(id);
        if (!tab) throw new Error(`layout references unknown Tab ${id}`);
        return this.#registry.createRenderer(tab);
      },
      createTabComponent: ({ id }) => {
        const tab = this.#tabs.get(id);
        if (!tab) return undefined;
        return new CcsmTabRenderer(
          tab,
          this.#activeSnapshot?.cliSessions ?? [],
        );
      },
      defaultTabComponent: "ccsm-tab",
      disableFloatingGroups: true,
      dndStrategy: DOCKVIEW_DND_STRATEGY,
      defaultRenderer: "always",
      getTabContextMenuItems: (params) =>
        createTabContextMenuItems(params, () =>
          this.#beginTabContextMenuOcclusion(),
        ),
      keyboardNavigation: true,
    });
    this.#dockview.onDidLayoutChange(() => this.#handleDockviewStateChange());
    this.#dockview.onDidActivePanelChange(() =>
      this.#handleDockviewStateChange(),
    );
    this.#dockview.onDidRemovePanel((panel) =>
      this.#handleRemovedPanel(panel.id),
    );
    this.#dockview.onWillDragPanel(() => this.#beginDockDrag());
    this.#dockview.onWillDragGroup(() => this.#beginDockDrag());
    this.#dockview.onDidDrop(() => this.#finishDockDrag());
    this.#spaceTree = new SpaceTreeView(root, {
      pickSpaceRoot: (initialPath) => this.#pickSpaceRoot(initialPath),
      switchSpace: (spaceId) => this.switchSpace(spaceId),
      createSpace: (name, rootPath, folderId) =>
        this.createSpace(name, rootPath, folderId),
      renameSpace: (spaceId, name) => this.renameSpace(spaceId, name),
      deleteSpace: (spaceId) => this.deleteSpace(spaceId),
      createFolder: (name, parentId) => this.createFolder(name, parentId),
      renameFolder: (folderId, name) => this.renameFolder(folderId, name),
      setFolderCollapsed: (folderId, collapsed) =>
        this.setFolderCollapsed(folderId, collapsed),
      deleteFolder: (folderId) => this.deleteFolder(folderId),
      moveSpace: (spaceId, folderId, order) =>
        this.moveSpace(spaceId, folderId, order),
      moveFolder: (folderId, parentId, order) =>
        this.moveFolder(folderId, parentId, order),
    });
    const newTabButton = requiredElement<HTMLButtonElement>(root, "#new-tab");
    const newTabMenu = requiredElement<HTMLElement>(root, "#new-tab-menu");
    newTabMenu.replaceChildren(
      ...NEW_TAB_ACTIONS.map((action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.role = "menuitem";
        button.dataset.newTabAction = action.id;
        button.textContent = action.label;
        return button;
      }),
    );
    newTabButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.#setNewTabMenuOpen(newTabMenu, newTabButton, newTabMenu.hidden);
    });
    newTabMenu.addEventListener("click", (event) => {
      const button = (
        event.target as Element | null
      )?.closest<HTMLButtonElement>("button[data-new-tab-action]");
      const action = NEW_TAB_ACTIONS.find(
        (candidate) => candidate.id === button?.dataset.newTabAction,
      );
      if (!action) return;
      void this.#setNewTabMenuOpen(newTabMenu, newTabButton, false).then(() =>
        this.#runNewTabAction(action),
      );
    });
    document.addEventListener("pointerdown", (event) => {
      if (
        (event.target as Node | null) &&
        !newTabMenu.parentElement?.contains(event.target as Node)
      ) {
        void this.#setNewTabMenuOpen(newTabMenu, newTabButton, false);
      }
    });
    void desktopClient.browser.subscribeNewWindow((request) => {
      void this.#openBrowserNewWindow(request.sourceSurfaceId, request.url);
    });
    void desktopClient.events
      .subscribe((event) => {
        if (event.kind !== "agent.activityChanged") return;
        if (!this.#agentList.updateActivity(event.payload)) {
          void this.#refreshAgents();
        }
      })
      .then((unlisten) => (this.#eventUnlisten = unlisten));
    window.addEventListener("beforeunload", () => {
      this.#tabContextMenuObserver?.disconnect();
      this.#eventUnlisten?.();
      this.#eventUnlisten = null;
      this.#terminalProvider.destroyAll();
      void this.flushLayout();
    });
  }

  async start(): Promise<void> {
    this.#setGlobalStatus("starting", "opening data.db");
    try {
      await desktopClient.windowChrome.setTheme(this.theme.current);
      const state = await desktopClient.backend.bootstrap();
      this.#bootstrap = state;
      await this.#activateSnapshot(state.activeSnapshot);
      this.#spaceTree.render(state);
      await this.#refreshAgents();
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
      throw error;
    }
  }

  async switchSpace(spaceId: string): Promise<void> {
    if (spaceId === this.#activeSnapshot?.space.id) return;
    await this.#tabDeletionQueue;
    await this.flushLayout();
    this.#setGlobalStatus("starting", "switching Space");
    try {
      const state = await desktopClient.backend.switchSpace(spaceId);
      await this.#commitWorkspaceState(state);
      await this.#refreshAgents();
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async createSpace(
    name: string,
    rootPath: string,
    folderId: string | null,
  ): Promise<void> {
    await this.#tabDeletionQueue;
    await this.flushLayout();
    await this.#mutateWorkspace(
      "creating Space",
      desktopClient.backend.createSpace({ name, rootPath, folderId }),
    );
  }

  async #pickSpaceRoot(initialPath: string | null): Promise<string | null> {
    await this.#surfaceOcclusion.set("directory-dialog", true);
    try {
      return await this.#directoryPicker.open(initialPath, initialPath);
    } finally {
      await this.#surfaceOcclusion.set("directory-dialog", false);
    }
  }

  async #setNewTabMenuOpen(
    menu: HTMLElement,
    button: HTMLButtonElement,
    open: boolean,
  ): Promise<void> {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    await this.#surfaceOcclusion.set("new-tab-menu", open);
  }

  #beginTabContextMenuOcclusion(): void {
    this.#tabContextMenuObserver?.disconnect();
    this.#tabContextMenuObserver = null;
    const token = ++this.#tabContextMenuToken;
    void this.#surfaceOcclusion.set("tab-context-menu", true);

    queueMicrotask(() => {
      if (token !== this.#tabContextMenuToken) return;
      const menus =
        this.root.ownerDocument.querySelectorAll<HTMLElement>(
          ".dv-context-menu",
        );
      const menu = menus.item(menus.length - 1);
      if (!menu) {
        this.#finishTabContextMenuOcclusion(token);
        return;
      }
      const observer = new MutationObserver(() => {
        if (!menu.isConnected) this.#finishTabContextMenuOcclusion(token);
      });
      observer.observe(this.root.ownerDocument.documentElement, {
        childList: true,
        subtree: true,
      });
      this.#tabContextMenuObserver = observer;
    });
  }

  #finishTabContextMenuOcclusion(token: number): void {
    if (token !== this.#tabContextMenuToken) return;
    this.#tabContextMenuToken += 1;
    this.#tabContextMenuObserver?.disconnect();
    this.#tabContextMenuObserver = null;
    void this.#surfaceOcclusion.set("tab-context-menu", false);
  }

  async renameSpace(spaceId: string, name: string): Promise<void> {
    await this.#mutateWorkspace(
      "renaming Space",
      desktopClient.backend.renameSpace({ spaceId, name }),
    );
  }

  async deleteSpace(spaceId: string): Promise<void> {
    await this.#tabDeletionQueue;
    if (spaceId === this.#activeSnapshot?.space.id) await this.flushLayout();
    let deletedTabs: TabDto[] = [];
    const target = this.#bootstrap?.spaces.find(
      (space) => space.id === spaceId,
    );
    if (target) {
      const snapshot =
        spaceId === this.#activeSnapshot?.space.id
          ? this.#activeSnapshot
          : await desktopClient.backend.loadSpace(spaceId);
      deletedTabs = snapshot.tabs;
      await Promise.all(
        snapshot.tabs
          .filter((tab) => tab.kind === "browser")
          .map((tab) =>
            desktopClient.browser
              .close(tab.resourceId ?? tab.id)
              .catch(() => {}),
          ),
      );
    }
    await this.#mutateWorkspace(
      "deleting Space",
      desktopClient.backend.deleteSpace({ spaceId }),
    );
    if (!this.#bootstrap?.spaces.some((space) => space.id === spaceId)) {
      this.#terminalProvider.releaseTabs(
        deletedTabs
          .filter((tab) => tab.kind === "cli-session")
          .map((tab) => tab.id),
      );
    }
  }

  async createFolder(name: string, parentId: string | null): Promise<void> {
    await this.#mutateWorkspace(
      "creating Folder",
      desktopClient.backend.createFolder({ name, parentId }),
    );
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    await this.#mutateWorkspace(
      "renaming Folder",
      desktopClient.backend.renameFolder({ folderId, name }),
    );
  }

  async setFolderCollapsed(
    folderId: string,
    collapsed: boolean,
  ): Promise<void> {
    await this.#mutateWorkspace(
      collapsed ? "collapsing Folder" : "expanding Folder",
      desktopClient.backend.setFolderCollapsed({ folderId, collapsed }),
      false,
    );
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.#mutateWorkspace(
      "deleting Folder",
      desktopClient.backend.deleteFolder({ folderId }),
    );
  }

  async moveSpace(
    spaceId: string,
    folderId: string | null,
    order: number,
  ): Promise<void> {
    await this.#mutateWorkspace(
      "moving Space",
      desktopClient.backend.moveSpace({ spaceId, folderId, order }),
    );
  }

  async moveFolder(
    folderId: string,
    parentId: string | null,
    order: number,
  ): Promise<void> {
    await this.#mutateWorkspace(
      "moving Folder",
      desktopClient.backend.moveFolder({ folderId, parentId, order }),
    );
  }

  async createCliTab(provider: ProviderKind): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    this.#setGlobalStatus("starting", `creating ${provider} Tab`);
    try {
      const created = await desktopClient.backend.createCliTab({
        spaceId: snapshot.space.id,
        provider,
      });
      snapshot.cliSessions.push(created.cliSession);
      this.#addCreatedTab(created.tab);
      await this.#refreshAgents();
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async #runNewTabAction(action: NewTabAction): Promise<void> {
    if (action.type === "cli") {
      await this.createCliTab(action.provider);
      return;
    }
    switch (action.tabKind) {
      case "browser":
        await this.#createBrowserTab();
        return;
      case "file-explorer":
        await this.#createFileExplorerTab();
        return;
      case "git":
        await this.#openGitTab();
        return;
      case "cli-session":
        return;
    }
  }

  async #createBrowserTab(): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    this.#setGlobalStatus("starting", "creating Browser Tab");
    try {
      const tab = await desktopClient.backend.createBrowserTab({
        spaceId: snapshot.space.id,
        url: "https://example.com/",
      });
      this.#addCreatedTab(tab);
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async #createFileExplorerTab(): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    this.#setGlobalStatus("starting", "creating File Explorer Tab");
    try {
      const tab = await desktopClient.backend.createFileExplorerTab({
        spaceId: snapshot.space.id,
      });
      this.#addCreatedTab(tab);
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async #openGitTab(): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    const existing = snapshot.tabs.find((tab) => tab.kind === "git");
    if (existing) {
      this.#focusTab(existing);
      return;
    }
    this.#setGlobalStatus("starting", "creating Git Tab");
    try {
      const tab = await desktopClient.backend.createGitTab({
        spaceId: snapshot.space.id,
      });
      this.#addCreatedTab(tab);
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  #focusTab(tab: TabDto): void {
    let panel = findDockPanelById(this.#dockview.panels, tab.id);
    if (!panel) {
      panel = this.#dockview.addPanel({
        id: tab.id,
        component: tab.kind,
        title: tab.title,
        renderer: "always",
        ...(this.#dockview.activePanel
          ? {
              position: {
                referencePanel: this.#dockview.activePanel.id,
                direction: "within" as const,
              },
            }
          : {}),
      });
    }
    this.#dockview.setActivePanel(panel);
    requestAnimationFrame(() => this.#terminalProvider.focusTab(tab.id));
    this.#setGlobalStatus("running", "ready");
  }

  #addCreatedTab(tab: TabDto, reference = this.#dockview.activePanel): void {
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    snapshot.tabs.push(tab);
    this.#tabs.set(tab.id, tab);
    const panel = this.#dockview.addPanel({
      id: tab.id,
      component: tab.kind,
      title: tab.title,
      renderer: "always",
      ...(reference
        ? {
            position: {
              referencePanel: reference.id,
              direction: BROWSER_POPUP_DOCK_DIRECTION,
            },
          }
        : {}),
    });
    this.#dockview.setActivePanel(panel);
    this.#scheduleLayoutSave();
  }

  async flushLayout(): Promise<void> {
    if (this.#saveTimer !== null) {
      window.clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    if (!this.#activeSnapshot || this.#restoring) return;
    const revision = this.#layoutRevision + 1;
    const saved = await desktopClient.backend.saveLayout({
      spaceId: this.#activeSnapshot.space.id,
      dockviewSnapshot: this.#dockview.toJSON(),
      activeTabId: this.#dockview.activePanel?.id ?? null,
      focusedGroupId: this.#dockview.activePanel?.group.id ?? null,
      layoutRevision: revision,
    });
    this.#layoutRevision = saved.layoutRevision;
  }

  snapshot(): object {
    return {
      activeSpaceId: this.#activeSnapshot?.space.id ?? null,
      theme: this.theme.current,
      spaces: this.#bootstrap?.spaces ?? [],
      folders: this.#bootstrap?.folders ?? [],
      agents: this.#agentList.snapshot(),
      tabs: [...this.#tabs.values()],
      layoutRevision: this.#layoutRevision,
      panels: this.#dockview.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        groupId: panel.group.id,
        active: panel.id === this.#dockview.activePanel?.id,
      })),
      groupCount: this.#dockview.groups.length,
    };
  }

  async #activateSnapshot(snapshot: SpaceSnapshotDto): Promise<void> {
    this.#restoring = true;
    try {
      this.#activeSnapshot = snapshot;
      this.#layoutRevision = snapshot.layout.layoutRevision;
      this.#tabs.clear();
      for (const tab of snapshot.tabs) this.#tabs.set(tab.id, tab);
      this.#dockview.clear();
      const serialized = isSerializedDockview(snapshot.layout.dockviewSnapshot)
        ? snapshot.layout.dockviewSnapshot
        : null;
      if (serialized) {
        this.#dockview.fromJSON(serialized);
      } else {
        this.#createDefaultLayout(snapshot.tabs);
      }
      this.#addMissingPanels(snapshot.tabs);
      const restoredActivePanel = findRestoredActivePanel(
        this.#dockview.panels,
        this.#dockview.groups,
        snapshot.layout.activeTabId,
        snapshot.layout.focusedGroupId,
      );
      if (restoredActivePanel)
        this.#dockview.setActivePanel(restoredActivePanel);
      this.#renderActiveSpace(snapshot);
    } finally {
      this.#restoring = false;
    }
    this.#syncAgentForeground();
    this.#scheduleLayoutSave();
  }

  #createDefaultLayout(tabs: TabDto[]): void {
    const terminal = tabs.find((tab) => tab.kind === "cli-session");
    const browser = tabs.find((tab) => tab.kind === "browser");
    const terminalPanel = terminal
      ? this.#dockview.addPanel({
          id: terminal.id,
          component: terminal.kind,
          title: terminal.title,
          renderer: "always",
          initialWidth: 720,
        })
      : null;
    if (browser) {
      this.#dockview.addPanel({
        id: browser.id,
        component: browser.kind,
        title: browser.title,
        renderer: "always",
        initialWidth: 540,
        ...(terminalPanel
          ? {
              position: {
                referencePanel: terminalPanel,
                direction: "right" as const,
              },
            }
          : {}),
      });
    }
    if (terminalPanel) this.#dockview.setActivePanel(terminalPanel);
  }

  #addMissingPanels(tabs: TabDto[]): void {
    const existing = new Set(this.#dockview.panels.map((panel) => panel.id));
    const reference =
      this.#dockview.panels.find(
        (panel) => panel.id === this.#dockview.activePanel?.id,
      ) ?? this.#dockview.panels[0];
    for (const tab of tabs) {
      if (existing.has(tab.id)) continue;
      this.#dockview.addPanel({
        id: tab.id,
        component: tab.kind,
        title: tab.title,
        renderer: "always",
        inactive: true,
        ...(reference
          ? {
              position: {
                referencePanel: reference.id,
                direction: "within" as const,
              },
            }
          : {}),
      });
      existing.add(tab.id);
    }
  }

  #scheduleLayoutSave(): void {
    if (this.#restoring) return;
    if (this.#saveTimer !== null) window.clearTimeout(this.#saveTimer);
    this.#saveTimer = window.setTimeout(() => {
      this.#saveTimer = null;
      void this.flushLayout().catch((error) => {
        this.#setGlobalStatus("error", `layout save · ${describeError(error)}`);
      });
    }, 250);
  }

  #handleDockviewStateChange(): void {
    this.#scheduleLayoutSave();
    this.#syncAgentForeground();
  }

  #handleRemovedPanel(tabId: string): void {
    this.#syncAgentForeground();
    const tab = this.#tabs.get(tabId);
    if (
      this.#pendingTabDeletions.has(tabId) ||
      !shouldDeleteRemovedTab(this.#restoring, tab)
    ) {
      return;
    }
    this.#pendingTabDeletions.add(tabId);
    this.#tabDeletionQueue = this.#tabDeletionQueue
      .then(() => this.#deleteTabFromSpace(tab))
      .catch((error) => {
        if (
          this.#activeSnapshot?.space.id === tab.spaceId &&
          this.#tabs.has(tab.id)
        ) {
          this.#focusTab(tab);
        }
        this.#setGlobalStatus("error", `close Tab · ${describeError(error)}`);
      })
      .finally(() => this.#pendingTabDeletions.delete(tabId));
  }

  async #deleteTabFromSpace(tab: TabDto): Promise<void> {
    if (this.#activeSnapshot?.space.id !== tab.spaceId) {
      throw new Error("Tab Space changed while closing");
    }
    this.#setGlobalStatus("starting", `deleting ${tab.title} Tab`);
    await this.flushLayout();
    const deleted = await desktopClient.backend.deleteTab({
      spaceId: tab.spaceId,
      tabId: tab.id,
    });
    const snapshot = this.#activeSnapshot;
    if (snapshot?.space.id === deleted.spaceId) {
      removeById(snapshot.tabs, deleted.id);
      this.#tabs.delete(deleted.id);
      if (deleted.kind === "cli-session" && deleted.resourceId) {
        removeById(snapshot.cliSessions, deleted.resourceId);
      }
    }
    if (deleted.kind === "cli-session") {
      this.#terminalProvider.releaseTabs([deleted.id]);
    } else if (deleted.kind === "browser") {
      await desktopClient.browser.close(deleted.resourceId ?? deleted.id);
    }
    await this.#refreshAgents();
    this.#setGlobalStatus("running", "ready");
  }

  #syncAgentForeground(): void {
    this.#agentList.setForegroundTabs(
      this.#activeSnapshot?.space.id ?? null,
      findVisibleDockPanelIds(this.#dockview.groups),
    );
  }

  async #mutateWorkspace(
    status: string,
    operation: Promise<BootstrapDto>,
    showBusy = true,
  ): Promise<void> {
    if (showBusy) this.#setGlobalStatus("starting", status);
    try {
      await this.#commitWorkspaceState(await operation);
      await this.#refreshAgents();
      if (showBusy) this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async #commitWorkspaceState(state: BootstrapDto): Promise<void> {
    const activeChanged =
      state.activeSpaceId !== this.#activeSnapshot?.space.id;
    this.#bootstrap = state;
    if (activeChanged || !this.#activeSnapshot) {
      await this.#activateSnapshot(state.activeSnapshot);
    } else {
      this.#activeSnapshot = state.activeSnapshot;
      this.#renderActiveSpace(state.activeSnapshot);
    }
    this.#spaceTree.render(state);
  }

  #renderActiveSpace(snapshot: SpaceSnapshotDto): void {
    requiredElement(this.root, "#active-space-name").textContent =
      snapshot.space.name;
    requiredElement(this.root, "#active-space-root").textContent =
      snapshot.space.rootPath;
  }

  async #refreshAgents(): Promise<void> {
    this.#agentList.render(await desktopClient.backend.listAgents());
  }

  async #focusAgent(agent: AgentSummaryDto): Promise<void> {
    if (this.#activeSnapshot?.space.id !== agent.spaceId) {
      await this.switchSpace(agent.spaceId);
    }
    if (this.#activeSnapshot?.space.id !== agent.spaceId) return;
    const tab = this.#activeSnapshot.tabs.find(
      (candidate) => candidate.id === agent.tabId,
    );
    if (!tab) {
      this.#setGlobalStatus("error", "Agent Tab is unavailable");
      return;
    }
    this.#focusTab(tab);
  }

  #setGlobalStatus(state: string, text: string): void {
    const status = requiredElement<HTMLElement>(this.root, "#global-status");
    status.dataset.state = state;
    status.textContent = text;
  }

  #beginDockDrag(): void {
    if (this.#dockDragActive) return;
    this.#dockDragActive = true;
    this.#browserProvider.setDockDragSuspended(true);
    window.addEventListener("pointerup", this.#finishDockDrag, {
      capture: true,
      once: true,
    });
    window.addEventListener("pointercancel", this.#finishDockDrag, {
      capture: true,
      once: true,
    });
    window.addEventListener("blur", this.#finishDockDrag, { once: true });
    window.addEventListener("keydown", this.#finishDockDragOnEscape, {
      capture: true,
    });
  }

  readonly #finishDockDragOnEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.#finishDockDrag();
  };

  readonly #finishDockDrag = (): void => {
    if (!this.#dockDragActive) return;
    this.#dockDragActive = false;
    window.removeEventListener("pointerup", this.#finishDockDrag, true);
    window.removeEventListener("pointercancel", this.#finishDockDrag, true);
    window.removeEventListener("blur", this.#finishDockDrag);
    window.removeEventListener("keydown", this.#finishDockDragOnEscape, true);
    requestAnimationFrame(() =>
      this.#browserProvider.setDockDragSuspended(false),
    );
  };

  async #openBrowserNewWindow(
    sourceSurfaceId: string,
    url: string,
  ): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    const sourceTab = findSourceBrowserTab(
      this.#tabs.values(),
      sourceSurfaceId,
    );
    const sourcePanel = sourceTab
      ? findDockPanelById(this.#dockview.panels, sourceTab.id)
      : undefined;
    this.#setGlobalStatus("starting", "opening Browser Tab");
    try {
      const tab = await desktopClient.backend.createBrowserTab({
        spaceId: snapshot.space.id,
        url,
      });
      const reference =
        sourcePanel ?? this.#dockview.activePanel ?? this.#dockview.panels[0];
      this.#addCreatedTab(tab, reference);
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus(
        "error",
        `open Browser Tab · ${describeError(error)}`,
      );
    }
  }
}

function requiredElement<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing required element: ${selector}`);
  return element;
}

function isSerializedDockview(value: unknown): value is SerializedDockview {
  return Boolean(
    value && typeof value === "object" && "grid" in value && "panels" in value,
  );
}

function removeById<T extends { id: string }>(items: T[], id: string): void {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) items.splice(index, 1);
}
