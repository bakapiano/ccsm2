import {
  DockviewComponent,
  type DockviewGroupPanel,
  type IDockviewPanel,
  type SerializedDockview,
} from "dockview";
import "dockview/dist/styles/dockview.css";

import { AgentListView } from "./agent-list";
import {
  type AppDialogOptions,
  type AppDialogResult,
  showAppDialog,
} from "./app-dialog";
import { agentCliTabCloseDialogOptions } from "./cli-tab-close-dialog";
import type { AgentSummaryDto } from "./generated/AgentSummaryDto";
import type { BootstrapDto } from "./generated/BootstrapDto";
import { DirectoryPickerDialog } from "./directory-picker";
import { DockNewTabAction, dockNewTabMenuPosition } from "./dock-new-tab";
import { deferredDockviewSnapshot } from "./dock-restore";
import { DeferredContentRenderer } from "./deferred-content-renderer";
import {
  distinctFileEditorTitles,
  normalizeRelativePath,
  parseFileEditorState,
} from "./file-editor-model";
import {
  BROWSER_POPUP_DOCK_DIRECTION,
  DOCKVIEW_DND_STRATEGY,
  findDockPanelById,
  findNearestRightAlignedDockGroup,
  findRestoredActivePanel,
  findSourceBrowserTab,
  findVisibleDockPanelIds,
  shouldDeleteRemovedTab,
  syncDockPanelTitles,
} from "./dock-behavior";
import type { ProviderKind } from "./generated/ProviderKind";
import type { SpaceSnapshotDto } from "./generated/SpaceSnapshotDto";
import type { TabDto } from "./generated/TabDto";
import { NEW_TAB_ACTIONS, type NewTabAction } from "./new-tab-actions";
import { FrameTaskScheduler } from "./frame-task-scheduler";
import { SidebarLayoutController } from "./sidebar-layout";
import {
  type SpaceTreeConfirmationRequest,
  type SpaceTreeTextRequest,
  SpaceTreeView,
} from "./space-tree";
import { SurfaceOcclusionController } from "./surface-occlusion";
import { createTabContextMenuItems } from "./tab-context-menu";
import { CcsmTabRenderer } from "./tab-header";
import { closeTabAfterApproval } from "./tab-close";
import { BrowserTabProvider } from "./tabs/browser-provider";
import { FileEditorTabProvider } from "./tabs/file-editor-provider";
import { FileExplorerTabProvider } from "./tabs/file-explorer-provider";
import { GitTabProvider } from "./tabs/git-provider";
import { TabProviderRegistry } from "./tabs/registry";
import {
  TerminalTabProvider,
  type TerminalLinkOpenRequest,
} from "./tabs/terminal-provider";
import { type ThemeController, updateThemeButton } from "./theme";
import { describeError, desktopClient } from "./transport/desktop-client";
import { bindWindowChrome } from "./window-chrome";
import type { RendererHealthAppSnapshot } from "./renderer-health";
import type { RendererReadyResponse } from "./generated/RendererReadyResponse";

const DOCKVIEW_POPOVER_SELECTOR =
  ".dv-context-menu, .dv-tabs-overflow-container";

export class CcsmApp {
  readonly #dockview: DockviewComponent;
  readonly #registry = new TabProviderRegistry();
  readonly #restoreScheduler = new FrameTaskScheduler(2);
  readonly #materializedTabIds = new Set<string>();
  readonly #browserProvider: BrowserTabProvider;
  readonly #fileEditorProvider: FileEditorTabProvider;
  readonly #terminalProvider: TerminalTabProvider;
  readonly #surfaceOcclusion: SurfaceOcclusionController;
  readonly #directoryPicker = new DirectoryPickerDialog(
    desktopClient.directories,
  );
  readonly #agentList: AgentListView;
  readonly #tabs = new Map<string, TabDto>();
  readonly #spaceTree: SpaceTreeView;
  readonly #sidebarLayout: SidebarLayoutController;
  readonly #newTabMenu: HTMLElement;
  #newTabAnchor: HTMLButtonElement | null = null;
  #newTabTargetGroupId: string | null = null;
  #bootstrap: BootstrapDto | null = null;
  #activeSnapshot: SpaceSnapshotDto | null = null;
  #layoutRevision = 0;
  #saveTimer: number | null = null;
  #restoring = false;
  #dockDragActive = false;
  #dockviewPopoverObserver: MutationObserver | null = null;
  #dockviewPopoverToken = 0;
  #newTabMenuToken = 0;
  #eventUnlisten: (() => void) | null = null;
  #windowCloseUnlisten: (() => void) | null = null;
  #closingWindow = false;
  #dialogSequence = 0;
  #tabCloseRequestQueue: Promise<void> = Promise.resolve();
  #tabDeletionQueue: Promise<void> = Promise.resolve();
  readonly #pendingTabCloseRequests = new Set<string>();
  readonly #pendingTabDeletions = new Set<string>();
  readonly #approvedPanelRemovals = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly theme: ThemeController,
  ) {
    bindWindowChrome(root, desktopClient.windowChrome, () => {
      void this.#requestWindowClose();
    });
    this.#sidebarLayout = new SidebarLayoutController(
      root,
      window.localStorage,
    );
    this.#terminalProvider = new TerminalTabProvider(
      desktopClient,
      theme.current,
      (request) => void this.#openTerminalLink(request),
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
    this.#browserProvider = new BrowserTabProvider(desktopClient, {
      nativeSurfacesEnabled: import.meta.env.MODE !== "e2e",
    });
    this.#surfaceOcclusion = new SurfaceOcclusionController((occluded) =>
      this.#browserProvider.setOverlaySuspended(occluded),
    );
    this.#registry.register(this.#browserProvider);
    this.#fileEditorProvider = new FileEditorTabProvider(desktopClient, {
      presentationChanged: () => this.#refreshFileEditorTitles(),
      setDialogVisible: (visible) =>
        this.#surfaceOcclusion.set("file-editor-dialog", visible),
    });
    this.#registry.register(
      new FileExplorerTabProvider(desktopClient, (spaceId, relativePath) => {
        void this.#openFileEditor(spaceId, relativePath);
      }),
    );
    this.#registry.register(this.#fileEditorProvider);
    this.#registry.register(new GitTabProvider(desktopClient));
    this.#newTabMenu = requiredElement<HTMLElement>(root, "#new-tab-menu");
    this.#newTabMenu.replaceChildren(
      ...NEW_TAB_ACTIONS.map((action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.role = "menuitem";
        button.dataset.newTabAction = action.id;
        button.textContent = action.label;
        return button;
      }),
    );
    const dockRoot = requiredElement<HTMLElement>(root, "#dockview");
    this.#dockview = new DockviewComponent(dockRoot, {
      createComponent: ({ id }) => {
        const tab = this.#tabs.get(id);
        if (!tab) throw new Error(`layout references unknown Tab ${id}`);
        return new DeferredContentRenderer(
          id,
          () => this.#registry.createRenderer(tab),
          this.#restoreScheduler,
          (tabId) => this.#materializedTabIds.add(tabId),
        );
      },
      createTabComponent: ({ id }) => {
        const tab = this.#tabs.get(id);
        if (!tab) return undefined;
        return new CcsmTabRenderer(
          tab,
          this.#activeSnapshot?.cliSessions ?? [],
          (tabId) => this.#requestTabClose(tabId),
        );
      },
      defaultTabComponent: "ccsm-tab",
      createRightHeaderActionComponent: (group) =>
        new DockNewTabAction(group, (targetGroup, anchor) =>
          this.#toggleNewTabMenu(targetGroup, anchor),
        ),
      disableFloatingGroups: true,
      dndStrategy: DOCKVIEW_DND_STRATEGY,
      defaultRenderer: "onlyWhenVisible",
      getTabContextMenuItems: (params) =>
        createTabContextMenuItems(
          params,
          () => this.#beginDockviewPopoverOcclusion(),
          (panel) => this.#requestTabClose(panel.id),
        ),
      keyboardNavigation: true,
      noPanelsOverlay: "emptyGroup",
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
      requestText: (request) => this.#requestText(request),
      requestConfirmation: (request) => this.#requestConfirmation(request),
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
    this.#newTabMenu.addEventListener("click", (event) => {
      const button = (
        event.target as Element | null
      )?.closest<HTMLButtonElement>("button[data-new-tab-action]");
      const action = NEW_TAB_ACTIONS.find(
        (candidate) => candidate.id === button?.dataset.newTabAction,
      );
      if (!action) return;
      const targetGroupId = this.#newTabTargetGroupId;
      void this.#setNewTabMenuOpen(false).then(() =>
        this.#runNewTabAction(action, targetGroupId),
      );
    });
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node | null;
      if (!target || this.#newTabMenu.contains(target)) return;
      if (this.#newTabAnchor?.contains(target)) return;
      void this.#setNewTabMenuOpen(false);
    });
    document.addEventListener(
      "click",
      (event) => this.#prepareTabOverflowOcclusion(event),
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" || event.key === " ")
          this.#prepareTabOverflowOcclusion(event);
      },
      true,
    );
    window.addEventListener(
      "resize",
      () => void this.#setNewTabMenuOpen(false),
    );
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
    void desktopClient.windowChrome
      .subscribeCloseRequested(() => {
        void this.#requestWindowClose();
      })
      .then((unlisten) => (this.#windowCloseUnlisten = unlisten));
    window.addEventListener("beforeunload", () => {
      this.#dockviewPopoverObserver?.disconnect();
      this.#eventUnlisten?.();
      this.#eventUnlisten = null;
      this.#windowCloseUnlisten?.();
      this.#windowCloseUnlisten = null;
      this.#terminalProvider.destroyAll();
      this.#fileEditorProvider.destroyAll();
      this.#browserProvider.destroy();
      this.#restoreScheduler.clear();
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

  async #requestText(request: SpaceTreeTextRequest): Promise<string | null> {
    const result = await this.#showDialog({
      title: request.title,
      message: request.message,
      input: {
        label: request.label,
        value: request.value,
        required: true,
        maxLength: request.maxLength,
        tooLongMessage:
          request.maxLength === undefined
            ? undefined
            : `${request.label} cannot exceed ${request.maxLength} characters.`,
        selectOnOpen: true,
      },
      actions: [
        { id: "cancel", label: "Cancel" },
        { id: "submit", label: request.confirmLabel, primary: true },
      ] as const,
      cancelAction: "cancel" as const,
      submitAction: "submit" as const,
    });
    if (result.action !== "submit") return null;
    return result.inputValue?.trim() || null;
  }

  async #requestConfirmation(
    request: SpaceTreeConfirmationRequest,
  ): Promise<boolean> {
    const result = await this.#showDialog({
      title: request.title,
      message: request.message,
      actions: [
        { id: "cancel", label: "Cancel", autofocus: true },
        {
          id: "confirm",
          label: request.confirmLabel,
          danger: true,
        },
      ] as const,
      cancelAction: "cancel" as const,
      role: "alertdialog",
      tone: "danger",
    });
    return result.action === "confirm";
  }

  async #showDialog<T extends string>(
    options: AppDialogOptions<T>,
  ): Promise<AppDialogResult<T>> {
    const reason = `app-dialog-${++this.#dialogSequence}`;
    await this.#surfaceOcclusion.set(reason, true);
    try {
      return await showAppDialog(options);
    } finally {
      await this.#surfaceOcclusion.set(reason, false);
    }
  }

  #toggleNewTabMenu(
    group: DockviewGroupPanel,
    anchor: HTMLButtonElement,
  ): void {
    const open = this.#newTabMenu.hidden || this.#newTabAnchor !== anchor;
    void this.#setNewTabMenuOpen(open, group, anchor);
  }

  async #setNewTabMenuOpen(
    open: boolean,
    group?: DockviewGroupPanel,
    anchor?: HTMLButtonElement,
  ): Promise<void> {
    const token = ++this.#newTabMenuToken;
    this.#newTabAnchor?.setAttribute("aria-expanded", "false");
    if (open && group && anchor) {
      this.#dockview.doSetGroupActive(group);
      this.#newTabAnchor = anchor;
      this.#newTabTargetGroupId = group.id;
      anchor.setAttribute("aria-expanded", "true");
      const position = dockNewTabMenuPosition(
        anchor.getBoundingClientRect(),
        164,
        window.innerWidth,
      );
      this.#newTabMenu.style.left = `${position.left}px`;
      this.#newTabMenu.style.top = `${position.top}px`;
      this.#newTabMenu.hidden = true;
      await this.#surfaceOcclusion.set("new-tab-menu", true);
      if (
        token !== this.#newTabMenuToken ||
        !this.#surfaceOcclusion.isActive("new-tab-menu")
      )
        return;
      this.#newTabMenu.hidden = false;
    } else {
      this.#newTabMenu.hidden = true;
      this.#newTabAnchor = null;
      this.#newTabTargetGroupId = null;
      await this.#surfaceOcclusion.set("new-tab-menu", false);
    }
  }

  #prepareTabOverflowOcclusion(event: Event): void {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".dv-tabs-overflow-dropdown-default")
    ) {
      this.#beginDockviewPopoverOcclusion();
    }
  }

  #beginDockviewPopoverOcclusion(): void {
    this.#dockviewPopoverObserver?.disconnect();
    this.#dockviewPopoverObserver = null;
    const token = ++this.#dockviewPopoverToken;
    const documentElement = this.root.ownerDocument.documentElement;
    documentElement.dataset.browserOverlayPreparing = "true";
    void this.#surfaceOcclusion.set("dockview-popover", true).finally(() => {
      if (token === this.#dockviewPopoverToken)
        delete documentElement.dataset.browserOverlayPreparing;
    });

    queueMicrotask(() => {
      if (token !== this.#dockviewPopoverToken) return;
      const document = this.root.ownerDocument;
      if (!document.querySelector(DOCKVIEW_POPOVER_SELECTOR)) {
        this.#finishDockviewPopoverOcclusion(token);
        return;
      }
      const observer = new MutationObserver(() => {
        if (!document.querySelector(DOCKVIEW_POPOVER_SELECTOR))
          this.#finishDockviewPopoverOcclusion(token);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      this.#dockviewPopoverObserver = observer;
    });
  }

  #finishDockviewPopoverOcclusion(token: number): void {
    if (token !== this.#dockviewPopoverToken) return;
    this.#dockviewPopoverToken += 1;
    this.#dockviewPopoverObserver?.disconnect();
    this.#dockviewPopoverObserver = null;
    delete this.root.ownerDocument.documentElement.dataset
      .browserOverlayPreparing;
    void this.#surfaceOcclusion.set("dockview-popover", false);
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
      if (!(await this.#fileEditorProvider.requestCloseMany(deletedTabs)))
        return;
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

  async createCliTab(
    provider: ProviderKind,
    targetGroupId: string | null = null,
  ): Promise<void> {
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
      this.#addCreatedTab(created.tab, undefined, targetGroupId);
      await this.#refreshAgents();
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async #runNewTabAction(
    action: NewTabAction,
    targetGroupId: string | null,
  ): Promise<void> {
    if (action.type === "cli") {
      await this.createCliTab(action.provider, targetGroupId);
      return;
    }
    switch (action.tabKind) {
      case "browser":
        await this.#createBrowserTab(targetGroupId);
        return;
      case "file-explorer":
        await this.#createFileExplorerTab(targetGroupId);
        return;
      case "file-editor":
        return;
      case "git":
        await this.#openGitTab(targetGroupId);
        return;
      case "cli-session":
        return;
    }
  }

  async #createBrowserTab(targetGroupId: string | null): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    this.#setGlobalStatus("starting", "creating Browser Tab");
    try {
      const tab = await desktopClient.backend.createBrowserTab({
        spaceId: snapshot.space.id,
        url: "https://example.com/",
      });
      this.#addCreatedTab(tab, undefined, targetGroupId);
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async #createFileExplorerTab(targetGroupId: string | null): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    this.#setGlobalStatus("starting", "creating File Explorer Tab");
    try {
      const tab = await desktopClient.backend.createFileExplorerTab({
        spaceId: snapshot.space.id,
      });
      this.#addCreatedTab(tab, undefined, targetGroupId);
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async #openFileEditor(
    spaceId: string,
    relativePath: string,
    options: OpenFileEditorOptions = {},
  ): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot || snapshot.space.id !== spaceId) return;
    const path = normalizeRelativePath(relativePath);
    const existing = snapshot.tabs.find(
      (tab) =>
        tab.kind === "file-editor" &&
        normalizeRelativePath(
          tab.resourceId ?? parseFileEditorState(tab).relativePath,
        ) === path,
    );
    if (existing) {
      this.#focusTab(existing);
      if (options.position) {
        this.#fileEditorProvider.revealPosition(existing.id, options.position);
      }
      return;
    }
    this.#setGlobalStatus("starting", `opening ${path}`);
    try {
      const tab = await desktopClient.backend.createFileEditorTab({
        spaceId,
        relativePath: path,
      });
      const alreadyLoaded = snapshot.tabs.find(
        (candidate) => candidate.id === tab.id,
      );
      if (alreadyLoaded) this.#focusTab(alreadyLoaded);
      else {
        this.#addCreatedTab(tab, undefined, options.targetGroupId ?? null);
      }
      if (options.position) {
        this.#fileEditorProvider.revealPosition(tab.id, options.position);
      }
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", `open file · ${describeError(error)}`);
    }
  }

  async #openGitTab(targetGroupId: string | null): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    const existing = snapshot.tabs.find((tab) => tab.kind === "git");
    if (existing) {
      this.#focusTab(existing);
      return;
    }
    this.#setGlobalStatus("starting", "creating Changes Tab");
    try {
      const tab = await desktopClient.backend.createGitTab({
        spaceId: snapshot.space.id,
      });
      this.#addCreatedTab(tab, undefined, targetGroupId);
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus("error", describeError(error));
    }
  }

  async #openTerminalLink(request: TerminalLinkOpenRequest): Promise<void> {
    if (request.target.kind === "web") {
      await this.#openTerminalWebLink(request);
      return;
    }
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot || snapshot.space.id !== request.spaceId) return;
    const reference = request.target.reference;
    this.#setGlobalStatus("starting", `resolving ${reference.path}`);
    try {
      const resolved = await desktopClient.backend.resolveFileReference({
        spaceId: request.spaceId,
        path: reference.path,
      });
      await this.#openFileEditor(request.spaceId, resolved.relativePath, {
        targetGroupId: this.#terminalLinkTargetGroupId(request.sourceTabId),
        position:
          reference.line === null
            ? undefined
            : {
                line: reference.line,
                column: reference.column ?? 1,
              },
      });
    } catch (error) {
      this.#setGlobalStatus(
        "error",
        `open terminal file · ${describeError(error)}`,
      );
    }
  }

  async #openTerminalWebLink(request: TerminalLinkOpenRequest): Promise<void> {
    await this.#tabDeletionQueue;
    const snapshot = this.#activeSnapshot;
    if (!snapshot || snapshot.space.id !== request.spaceId) return;
    if (request.target.kind !== "web") return;
    this.#setGlobalStatus("starting", "opening Browser Tab");
    try {
      const tab = await desktopClient.backend.createBrowserTab({
        spaceId: request.spaceId,
        url: request.target.url,
      });
      this.#addCreatedTab(
        tab,
        undefined,
        this.#terminalLinkTargetGroupId(request.sourceTabId),
      );
      this.#setGlobalStatus("running", "ready");
    } catch (error) {
      this.#setGlobalStatus(
        "error",
        `open terminal link · ${describeError(error)}`,
      );
    }
  }

  #terminalLinkTargetGroupId(sourceTabId: string): string | null {
    const sourcePanel = findDockPanelById(this.#dockview.panels, sourceTabId);
    if (!sourcePanel) return null;
    return (
      findNearestRightAlignedDockGroup(sourcePanel.group, this.#dockview.groups)
        ?.id ?? sourcePanel.group.id
    );
  }

  #focusTab(tab: TabDto): void {
    let panel = findDockPanelById(this.#dockview.panels, tab.id);
    if (!panel) {
      panel = this.#dockview.addPanel({
        id: tab.id,
        component: tab.kind,
        title: tab.title,
        renderer: "onlyWhenVisible",
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
    if (tab.kind === "file-editor") this.#refreshFileEditorTitles();
    requestAnimationFrame(() => this.#terminalProvider.focusTab(tab.id));
    this.#setGlobalStatus("running", "ready");
  }

  #addCreatedTab(
    tab: TabDto,
    reference: IDockviewPanel | undefined = undefined,
    targetGroupId: string | null = null,
  ): void {
    const snapshot = this.#activeSnapshot;
    if (!snapshot) return;
    snapshot.tabs.push(tab);
    this.#tabs.set(tab.id, tab);
    const targetGroupExists =
      targetGroupId !== null &&
      this.#dockview.groups.some((group) => group.id === targetGroupId);
    const resolvedReference = targetGroupExists
      ? undefined
      : (reference ?? this.#dockview.activePanel);
    const panel = this.#dockview.addPanel({
      id: tab.id,
      component: tab.kind,
      title: tab.title,
      renderer: "onlyWhenVisible",
      ...(targetGroupExists
        ? {
            position: {
              referenceGroup: targetGroupId!,
              direction: "within" as const,
            },
          }
        : resolvedReference
          ? {
              position: {
                referencePanel: resolvedReference.id,
                direction: BROWSER_POPUP_DOCK_DIRECTION,
              },
            }
          : {}),
    });
    this.#dockview.setActivePanel(panel);
    this.#refreshFileEditorTitles();
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
      tabRestore: {
        materialized: this.#materializedTabIds.size,
        ...this.#restoreScheduler.snapshot(),
      },
    };
  }

  rendererHealthSnapshot(): RendererHealthAppSnapshot {
    const modalKind = this.root.querySelector(".app-dialog")
      ? "app"
      : this.root.querySelector(".directory-dialog")
        ? "directory"
        : null;
    return {
      dockDragging: this.#dockDragActive,
      sidebarResizing: this.root.dataset.sidebarResizing === "true",
      agentsResizing: this.root.dataset.agentsResizing === "true",
      modalKind,
      dirtyEditorCount: this.#fileEditorProvider.dirtyCount(),
      liveCliRuntimeCount: this.#terminalProvider.liveRuntimeCount(),
    };
  }

  async debugOpenFileEditors(relativePaths: readonly string[]): Promise<void> {
    const spaceId = this.#activeSnapshot?.space.id;
    if (!spaceId) throw new Error("active Space is unavailable");
    for (const relativePath of relativePaths) {
      await this.#openFileEditor(spaceId, normalizeRelativePath(relativePath));
    }
  }

  showRendererRecoveryNotice(response: RendererReadyResponse): void {
    this.root.querySelector(".renderer-recovery-notice")?.remove();
    const notice = document.createElement("aside");
    notice.className = "renderer-recovery-notice";
    notice.dataset.testid = "renderer-recovery-notice";
    const title = document.createElement("strong");
    title.textContent = "UI recovered";
    const detail = document.createElement("span");
    detail.textContent = response.incidentId
      ? `Input path restored · incident ${response.incidentId.slice(0, 8)}`
      : "Input path restored";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss recovery notice");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => notice.remove());
    notice.append(title, detail, dismiss);
    this.root.append(notice);
  }

  async #activateSnapshot(snapshot: SpaceSnapshotDto): Promise<void> {
    this.#restoring = true;
    try {
      this.#activeSnapshot = snapshot;
      this.#layoutRevision = snapshot.layout.layoutRevision;
      this.#restoreScheduler.clear();
      this.#materializedTabIds.clear();
      this.#tabs.clear();
      for (const tab of snapshot.tabs) this.#tabs.set(tab.id, tab);
      this.#dockview.clear();
      const serialized = isSerializedDockview(snapshot.layout.dockviewSnapshot)
        ? snapshot.layout.dockviewSnapshot
        : null;
      if (serialized) {
        this.#dockview.fromJSON(deferredDockviewSnapshot(serialized));
      } else {
        this.#createDefaultLayout(snapshot.tabs);
      }
      this.#addMissingPanels(snapshot.tabs);
      if (this.#dockview.groups.length === 0) this.#dockview.addGroup();
      syncDockPanelTitles(this.#dockview.panels, this.#tabs);
      this.#refreshFileEditorTitles();
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
          renderer: "onlyWhenVisible",
          initialWidth: 720,
        })
      : null;
    if (browser) {
      this.#dockview.addPanel({
        id: browser.id,
        component: browser.kind,
        title: browser.title,
        renderer: "onlyWhenVisible",
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
        renderer: "onlyWhenVisible",
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

  #requestTabClose(tabId: string): void {
    if (
      this.#restoring ||
      this.#pendingTabCloseRequests.has(tabId) ||
      !this.#tabs.has(tabId)
    ) {
      return;
    }
    this.#pendingTabCloseRequests.add(tabId);
    this.#tabCloseRequestQueue = this.#tabCloseRequestQueue
      .then(() => this.#closeTabAfterApproval(tabId))
      .catch((error) => {
        this.#setGlobalStatus("error", `close Tab · ${describeError(error)}`);
      })
      .finally(() => this.#pendingTabCloseRequests.delete(tabId));
  }

  async #closeTabAfterApproval(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    const snapshot = this.#activeSnapshot;
    if (!tab || !snapshot || snapshot.space.id !== tab.spaceId) return;
    const panel = findDockPanelById(this.#dockview.panels, tab.id);
    if (!panel) return;

    await closeTabAfterApproval(tab, {
      cliSessions: snapshot.cliSessions,
      confirmAgentCli: (candidate) => this.#requestAgentCliTabClose(candidate),
      confirmFileEditor: (candidate) =>
        this.#fileEditorProvider.requestClose(candidate),
      closePanel: () => {
        const currentPanel = findDockPanelById(this.#dockview.panels, tab.id);
        if (
          this.#tabs.get(tab.id) !== tab ||
          this.#activeSnapshot?.space.id !== tab.spaceId ||
          !currentPanel
        ) {
          return false;
        }
        this.#approvedPanelRemovals.add(tab.id);
        try {
          currentPanel.api.close();
        } finally {
          if (findDockPanelById(this.#dockview.panels, tab.id))
            this.#approvedPanelRemovals.delete(tab.id);
        }
        return true;
      },
    });
  }

  #handleRemovedPanel(tabId: string): void {
    this.#syncAgentForeground();
    const tab = this.#tabs.get(tabId);
    const approved = this.#approvedPanelRemovals.delete(tabId);
    if (
      this.#pendingTabDeletions.has(tabId) ||
      !shouldDeleteRemovedTab(this.#restoring, tab)
    ) {
      return;
    }
    if (!approved) {
      this.#focusTab(tab);
      this.#requestTabClose(tabId);
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
    } else if (deleted.kind === "file-editor") {
      this.#fileEditorProvider.releaseTab(deleted.id);
    }
    this.#refreshFileEditorTitles();
    await this.#refreshAgents();
    this.#setGlobalStatus("running", "ready");
  }

  async #requestAgentCliTabClose(tab: TabDto): Promise<boolean> {
    const result = await this.#showDialog(agentCliTabCloseDialogOptions(tab));
    return result.action === "close";
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
      import.meta.env.MODE === "e2e"
        ? "<E2E_SPACE_ROOT>"
        : snapshot.space.rootPath;
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

  #refreshFileEditorTitles(): void {
    const fileTabs = [...this.#tabs.values()]
      .filter((tab) => tab.kind === "file-editor")
      .map((tab) => ({
        id: tab.id,
        path: parseFileEditorState(tab).relativePath,
        dirty: this.#fileEditorProvider.isDirty(tab.id),
      }));
    const titles = distinctFileEditorTitles(fileTabs);
    for (const panel of this.#dockview.panels) {
      const title = titles.get(panel.id);
      if (title && panel.title !== title) panel.api.setTitle(title);
    }
  }

  async #requestWindowClose(): Promise<void> {
    if (this.#closingWindow) return;
    if (!(await this.#fileEditorProvider.requestCloseAll())) return;
    this.#closingWindow = true;
    try {
      await this.#tabDeletionQueue;
      await this.flushLayout();
      await desktopClient.windowChrome.close();
    } catch (error) {
      this.#closingWindow = false;
      this.#setGlobalStatus("error", `close · ${describeError(error)}`);
    }
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

interface OpenFileEditorOptions {
  targetGroupId?: string | null;
  position?: { line: number; column: number };
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
