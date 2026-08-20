import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";

import type { AppEvent } from "../generated/AppEvent";
import type { AgentSummaryDto } from "../generated/AgentSummaryDto";
import type { BootstrapDto } from "../generated/BootstrapDto";
import type { BrowserBounds } from "../generated/BrowserBounds";
import type { BrowserInfo } from "../generated/BrowserInfo";
import type { BrowserOpenRequest } from "../generated/BrowserOpenRequest";
import type { BrowserTitleChangedRequest } from "../generated/BrowserTitleChangedRequest";
import type { BrowseHostDirectoryRequest } from "../generated/BrowseHostDirectoryRequest";
import type { CliSessionDto } from "../generated/CliSessionDto";
import type { CreateBrowserTabRequest } from "../generated/CreateBrowserTabRequest";
import type { CreateCliTabRequest } from "../generated/CreateCliTabRequest";
import type { CreateFileEditorTabRequest } from "../generated/CreateFileEditorTabRequest";
import type { CreateFileExplorerTabRequest } from "../generated/CreateFileExplorerTabRequest";
import type { CreateFolderRequest } from "../generated/CreateFolderRequest";
import type { CreateGitTabRequest } from "../generated/CreateGitTabRequest";
import type { CreateHostDirectoryRequest } from "../generated/CreateHostDirectoryRequest";
import type { CreateSpaceRequest } from "../generated/CreateSpaceRequest";
import type { CreatedCliTabDto } from "../generated/CreatedCliTabDto";
import type { DeleteFolderRequest } from "../generated/DeleteFolderRequest";
import type { DeleteSpaceRequest } from "../generated/DeleteSpaceRequest";
import type { DeleteTabRequest } from "../generated/DeleteTabRequest";
import type { DirectoryListingDto } from "../generated/DirectoryListingDto";
import type { FileDocumentDto } from "../generated/FileDocumentDto";
import type { GitFileDiffDto } from "../generated/GitFileDiffDto";
import type { GitSnapshotDto } from "../generated/GitSnapshotDto";
import type { HostDirectoryEntryDto } from "../generated/HostDirectoryEntryDto";
import type { HostDirectoryListingDto } from "../generated/HostDirectoryListingDto";
import type { ListDirectoryRequest } from "../generated/ListDirectoryRequest";
import type { MoveFolderRequest } from "../generated/MoveFolderRequest";
import type { MoveSpaceRequest } from "../generated/MoveSpaceRequest";
import type { RenameFolderRequest } from "../generated/RenameFolderRequest";
import type { RenameSpaceRequest } from "../generated/RenameSpaceRequest";
import type { RefreshGitRequest } from "../generated/RefreshGitRequest";
import type { ReadFileRequest } from "../generated/ReadFileRequest";
import type { ReadGitDiffRequest } from "../generated/ReadGitDiffRequest";
import type { ReplaceCliSessionRequest } from "../generated/ReplaceCliSessionRequest";
import type { ResolveFileReferenceRequest } from "../generated/ResolveFileReferenceRequest";
import type { ResolvedFileReferenceDto } from "../generated/ResolvedFileReferenceDto";
import type { RuntimeEvent } from "../generated/RuntimeEvent";
import type { RuntimeStartedDto } from "../generated/RuntimeStartedDto";
import type { SaveLayoutRequest } from "../generated/SaveLayoutRequest";
import type { SetFolderCollapsedRequest } from "../generated/SetFolderCollapsedRequest";
import type { SpaceLayoutDto } from "../generated/SpaceLayoutDto";
import type { SpaceSnapshotDto } from "../generated/SpaceSnapshotDto";
import type { StartRuntimeRequest } from "../generated/StartRuntimeRequest";
import type { TabDto } from "../generated/TabDto";
import type { ThemeMode } from "../theme";
import type { UpdateTabStateRequest } from "../generated/UpdateTabStateRequest";
import type { WriteFileRequest } from "../generated/WriteFileRequest";
import type { WriteFileResultDto } from "../generated/WriteFileResultDto";

export interface AppBackendClient {
  bootstrap(): Promise<BootstrapDto>;
  listAgents(): Promise<AgentSummaryDto[]>;
  loadSpace(spaceId: string): Promise<SpaceSnapshotDto>;
  switchSpace(spaceId: string): Promise<BootstrapDto>;
  createSpace(request: CreateSpaceRequest): Promise<BootstrapDto>;
  renameSpace(request: RenameSpaceRequest): Promise<BootstrapDto>;
  deleteSpace(request: DeleteSpaceRequest): Promise<BootstrapDto>;
  createFolder(request: CreateFolderRequest): Promise<BootstrapDto>;
  renameFolder(request: RenameFolderRequest): Promise<BootstrapDto>;
  setFolderCollapsed(request: SetFolderCollapsedRequest): Promise<BootstrapDto>;
  deleteFolder(request: DeleteFolderRequest): Promise<BootstrapDto>;
  moveSpace(request: MoveSpaceRequest): Promise<BootstrapDto>;
  moveFolder(request: MoveFolderRequest): Promise<BootstrapDto>;
  listDirectory(request: ListDirectoryRequest): Promise<DirectoryListingDto>;
  cancelDirectoryOperation(operationId: string): Promise<void>;
  readFile(request: ReadFileRequest): Promise<FileDocumentDto>;
  resolveFileReference(
    request: ResolveFileReferenceRequest,
  ): Promise<ResolvedFileReferenceDto>;
  writeFile(request: WriteFileRequest): Promise<WriteFileResultDto>;
  cachedGit(spaceId: string): Promise<GitSnapshotDto>;
  refreshGit(request: RefreshGitRequest): Promise<GitSnapshotDto>;
  readGitDiff(request: ReadGitDiffRequest): Promise<GitFileDiffDto>;
  saveLayout(request: SaveLayoutRequest): Promise<SpaceLayoutDto>;
  updateTabState(request: UpdateTabStateRequest): Promise<TabDto>;
  deleteTab(request: DeleteTabRequest): Promise<TabDto>;
  createBrowserTab(request: CreateBrowserTabRequest): Promise<TabDto>;
  createFileExplorerTab(request: CreateFileExplorerTabRequest): Promise<TabDto>;
  createFileEditorTab(request: CreateFileEditorTabRequest): Promise<TabDto>;
  createGitTab(request: CreateGitTabRequest): Promise<TabDto>;
  createCliTab(request: CreateCliTabRequest): Promise<CreatedCliTabDto>;
  getCliSession(cliSessionId: string): Promise<CliSessionDto>;
  replaceCliSession(request: ReplaceCliSessionRequest): Promise<CliSessionDto>;
  startRuntime(
    request: StartRuntimeRequest,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<RuntimeStartedDto>;
  writeRuntime(runtimeId: string, data: string): Promise<void>;
  resizeRuntime(runtimeId: string, cols: number, rows: number): Promise<void>;
  acknowledgeRuntimeOutput(runtimeId: string, bytes: number): Promise<void>;
  stopRuntime(runtimeId: string): Promise<void>;
}

export interface BrowserSurfaceClient {
  create(
    surfaceId: string,
    bounds: BrowserBounds,
    url: string,
  ): Promise<BrowserInfo>;
  setBounds(surfaceId: string, bounds: BrowserBounds): Promise<void>;
  setVisible(surfaceId: string, visible: boolean): Promise<void>;
  capture(surfaceId: string): Promise<string>;
  focus(surfaceId: string): Promise<void>;
  navigate(surfaceId: string, url: string): Promise<string>;
  reload(surfaceId: string): Promise<void>;
  close(surfaceId: string): Promise<void>;
  subscribeNewWindow(
    listener: (request: BrowserOpenRequest) => void,
  ): Promise<UnlistenFn>;
  subscribeTitleChanged(
    listener: (request: BrowserTitleChangedRequest) => void,
  ): Promise<UnlistenFn>;
}

export interface DirectoryBrowserClient {
  browse(request: BrowseHostDirectoryRequest): Promise<HostDirectoryListingDto>;
  create(request: CreateHostDirectoryRequest): Promise<HostDirectoryEntryDto>;
  cancel(operationId: string): Promise<void>;
}

export interface ClipboardClient {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export type WindowResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export interface WindowChromeClient {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  startResizeDragging(direction: WindowResizeDirection): Promise<void>;
  setTheme(theme: ThemeMode): Promise<void>;
  close(): Promise<void>;
  subscribeFocusChanged(
    listener: (focused: boolean) => void,
  ): Promise<UnlistenFn>;
  subscribeCloseRequested(listener: () => void): Promise<UnlistenFn>;
}

export interface CcsmDesktopClient {
  backend: AppBackendClient;
  browser: BrowserSurfaceClient;
  clipboard: ClipboardClient;
  directories: DirectoryBrowserClient;
  windowChrome: WindowChromeClient;
  events: DesktopEventStream;
}

export interface DesktopEventStream {
  subscribe(listener: (event: AppEvent) => void): Promise<UnlistenFn>;
}

class TauriBackendClient implements AppBackendClient {
  bootstrap(): Promise<BootstrapDto> {
    return invoke("bootstrap");
  }

  listAgents(): Promise<AgentSummaryDto[]> {
    return invoke("list_agents");
  }

  loadSpace(spaceId: string): Promise<SpaceSnapshotDto> {
    return invoke("load_space", { spaceId });
  }

  switchSpace(spaceId: string): Promise<BootstrapDto> {
    return invoke("switch_space", { spaceId });
  }

  createSpace(request: CreateSpaceRequest): Promise<BootstrapDto> {
    return invoke("create_space", { request });
  }

  renameSpace(request: RenameSpaceRequest): Promise<BootstrapDto> {
    return invoke("rename_space", { request });
  }

  deleteSpace(request: DeleteSpaceRequest): Promise<BootstrapDto> {
    return invoke("delete_space", { request });
  }

  createFolder(request: CreateFolderRequest): Promise<BootstrapDto> {
    return invoke("create_folder", { request });
  }

  renameFolder(request: RenameFolderRequest): Promise<BootstrapDto> {
    return invoke("rename_folder", { request });
  }

  setFolderCollapsed(
    request: SetFolderCollapsedRequest,
  ): Promise<BootstrapDto> {
    return invoke("set_folder_collapsed", { request });
  }

  deleteFolder(request: DeleteFolderRequest): Promise<BootstrapDto> {
    return invoke("delete_folder", { request });
  }

  moveSpace(request: MoveSpaceRequest): Promise<BootstrapDto> {
    return invoke("move_space", { request });
  }

  moveFolder(request: MoveFolderRequest): Promise<BootstrapDto> {
    return invoke("move_folder", { request });
  }

  listDirectory(request: ListDirectoryRequest): Promise<DirectoryListingDto> {
    return invoke("list_directory", { request });
  }

  cancelDirectoryOperation(operationId: string): Promise<void> {
    return invoke("cancel_directory_operation", { operationId });
  }

  readFile(request: ReadFileRequest): Promise<FileDocumentDto> {
    return invoke("read_file", { request });
  }

  resolveFileReference(
    request: ResolveFileReferenceRequest,
  ): Promise<ResolvedFileReferenceDto> {
    return invoke("resolve_file_reference", { request });
  }

  writeFile(request: WriteFileRequest): Promise<WriteFileResultDto> {
    return invoke("write_file", { request });
  }

  cachedGit(spaceId: string): Promise<GitSnapshotDto> {
    return invoke("cached_git", { spaceId });
  }

  refreshGit(request: RefreshGitRequest): Promise<GitSnapshotDto> {
    return invoke("refresh_git", { request });
  }

  readGitDiff(request: ReadGitDiffRequest): Promise<GitFileDiffDto> {
    return invoke("read_git_diff", { request });
  }

  saveLayout(request: SaveLayoutRequest): Promise<SpaceLayoutDto> {
    return invoke("save_layout", { request });
  }

  updateTabState(request: UpdateTabStateRequest): Promise<TabDto> {
    return invoke("update_tab_state", { request });
  }

  deleteTab(request: DeleteTabRequest): Promise<TabDto> {
    return invoke("delete_tab", { request });
  }

  createBrowserTab(request: CreateBrowserTabRequest): Promise<TabDto> {
    return invoke("create_browser_tab", { request });
  }

  createFileExplorerTab(
    request: CreateFileExplorerTabRequest,
  ): Promise<TabDto> {
    return invoke("create_file_explorer_tab", { request });
  }

  createFileEditorTab(request: CreateFileEditorTabRequest): Promise<TabDto> {
    return invoke("create_file_editor_tab", { request });
  }

  createGitTab(request: CreateGitTabRequest): Promise<TabDto> {
    return invoke("create_git_tab", { request });
  }

  createCliTab(request: CreateCliTabRequest): Promise<CreatedCliTabDto> {
    return invoke("create_cli_tab", { request });
  }

  getCliSession(cliSessionId: string): Promise<CliSessionDto> {
    return invoke("get_cli_session", { cliSessionId });
  }

  replaceCliSession(request: ReplaceCliSessionRequest): Promise<CliSessionDto> {
    return invoke("replace_cli_session", { request });
  }

  startRuntime(
    request: StartRuntimeRequest,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<RuntimeStartedDto> {
    const channel = new Channel<RuntimeEvent>();
    channel.onmessage = onEvent;
    return invoke("start_runtime", { request, onEvent: channel });
  }

  writeRuntime(runtimeId: string, data: string): Promise<void> {
    return invoke("write_runtime", { runtimeId, data });
  }

  resizeRuntime(runtimeId: string, cols: number, rows: number): Promise<void> {
    return invoke("resize_runtime", { runtimeId, cols, rows });
  }

  acknowledgeRuntimeOutput(runtimeId: string, bytes: number): Promise<void> {
    return invoke("acknowledge_runtime_output", { runtimeId, bytes });
  }

  stopRuntime(runtimeId: string): Promise<void> {
    return invoke("stop_runtime", { runtimeId });
  }
}

class TauriBrowserSurfaceClient implements BrowserSurfaceClient {
  create(
    surfaceId: string,
    bounds: BrowserBounds,
    url: string,
  ): Promise<BrowserInfo> {
    return invoke("create_browser", { surfaceId, bounds, url });
  }

  setBounds(surfaceId: string, bounds: BrowserBounds): Promise<void> {
    return invoke("set_browser_bounds", { surfaceId, bounds });
  }

  setVisible(surfaceId: string, visible: boolean): Promise<void> {
    return invoke("set_browser_visible", { surfaceId, visible });
  }

  capture(surfaceId: string): Promise<string> {
    return invoke("capture_browser", { surfaceId });
  }

  focus(surfaceId: string): Promise<void> {
    return invoke("focus_browser", { surfaceId });
  }

  navigate(surfaceId: string, url: string): Promise<string> {
    return invoke("navigate_browser", { surfaceId, url });
  }

  reload(surfaceId: string): Promise<void> {
    return invoke("reload_browser", { surfaceId });
  }

  close(surfaceId: string): Promise<void> {
    return invoke("close_browser", { surfaceId });
  }

  subscribeNewWindow(
    listener: (request: BrowserOpenRequest) => void,
  ): Promise<UnlistenFn> {
    return listen<BrowserOpenRequest>("ccsm:browser-new-window", (event) =>
      listener(event.payload),
    );
  }

  subscribeTitleChanged(
    listener: (request: BrowserTitleChangedRequest) => void,
  ): Promise<UnlistenFn> {
    return listen<BrowserTitleChangedRequest>(
      "ccsm:browser-title-changed",
      (event) => listener(event.payload),
    );
  }
}

class TauriDirectoryBrowserClient implements DirectoryBrowserClient {
  browse(
    request: BrowseHostDirectoryRequest,
  ): Promise<HostDirectoryListingDto> {
    return invoke("browse_host_directory", { request });
  }

  create(request: CreateHostDirectoryRequest): Promise<HostDirectoryEntryDto> {
    return invoke("create_host_directory", { request });
  }

  cancel(operationId: string): Promise<void> {
    return invoke("cancel_directory_operation", { operationId });
  }
}

class TauriClipboardClient implements ClipboardClient {
  #pendingWrite: Promise<void> = Promise.resolve();

  writeText(text: string): Promise<void> {
    const operation = retryClipboardOperation(() => writeClipboardText(text));
    this.#pendingWrite = operation.catch(() => {});
    return operation;
  }

  async readText(): Promise<string> {
    await this.#pendingWrite;
    return retryClipboardOperation(readClipboardText);
  }
}

async function retryClipboardOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!String(error).includes("held by another party")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

class TauriWindowChromeClient implements WindowChromeClient {
  #allowClose = false;

  minimize(): Promise<void> {
    return getCurrentWindow().minimize();
  }

  toggleMaximize(): Promise<void> {
    return getCurrentWindow().toggleMaximize();
  }

  startResizeDragging(direction: WindowResizeDirection): Promise<void> {
    return getCurrentWindow().startResizeDragging(direction);
  }

  setTheme(theme: ThemeMode): Promise<void> {
    return getCurrentWindow().setTheme(theme);
  }

  close(): Promise<void> {
    this.#allowClose = true;
    return getCurrentWindow().close();
  }

  subscribeFocusChanged(
    listener: (focused: boolean) => void,
  ): Promise<UnlistenFn> {
    return getCurrentWindow().onFocusChanged((event) =>
      listener(event.payload),
    );
  }

  subscribeCloseRequested(listener: () => void): Promise<UnlistenFn> {
    return getCurrentWindow().onCloseRequested((event) => {
      if (this.#allowClose) {
        this.#allowClose = false;
        return;
      }
      event.preventDefault();
      listener();
    });
  }
}

export const desktopClient: CcsmDesktopClient = {
  backend: new TauriBackendClient(),
  browser: new TauriBrowserSurfaceClient(),
  clipboard: new TauriClipboardClient(),
  directories: new TauriDirectoryBrowserClient(),
  windowChrome: new TauriWindowChromeClient(),
  events: {
    subscribe(listener) {
      return listen<AppEvent>("ccsm:event", (event) => listener(event.payload));
    },
  },
};

export function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; code?: unknown };
    if (typeof value.message === "string") {
      return typeof value.code === "string"
        ? `${value.code}: ${value.message}`
        : value.message;
    }
  }
  return String(error);
}
