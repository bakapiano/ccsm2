use std::sync::Arc;

use ccsm_core::{
    RuntimeEventSink,
    dto::{
        AgentSummaryDto, BootstrapDto, CliSessionDto, CreateBrowserTabRequest, CreateCliTabRequest,
        CreateFileEditorTabRequest, CreateFileExplorerTabRequest, CreateFolderRequest,
        CreateGitTabRequest, CreateSpaceRequest, CreatedCliTabDto, DeleteFolderRequest,
        DeleteSpaceRequest, DeleteTabRequest, DirectoryListingDto, FileDocumentDto, GitSnapshotDto,
        ListDirectoryRequest, MoveFolderRequest, MoveSpaceRequest, ReadFileRequest,
        RefreshGitRequest, RenameFolderRequest, RenameSpaceRequest, ReplaceCliSessionRequest,
        ResolveFileReferenceRequest, ResolvedFileReferenceDto, RuntimeEvent, RuntimeStartedDto,
        SaveLayoutRequest, SetFolderCollapsedRequest, SpaceLayoutDto, SpaceSnapshotDto,
        StartRuntimeRequest, TabDto, UpdateTabStateRequest, WriteFileRequest, WriteFileResultDto,
    },
    error::{ApiErrorDto, BackendError},
};
use tauri::{AppHandle, State, Window, ipc::Channel};

use crate::{
    DesktopState,
    browser::{BrowserBounds, BrowserInfo},
    directory_browser::{
        BrowseHostDirectoryRequest, CreateHostDirectoryRequest, HostDirectoryEntryDto,
        HostDirectoryListingDto, workspace_root,
    },
};

type CommandResult<T> = Result<T, ApiErrorDto>;

async fn on_blocking_worker<T, F>(operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| {
            ApiErrorDto::from(BackendError::Platform(format!(
                "background worker failed: {error}"
            )))
        })?
}

#[tauri::command]
pub fn bootstrap(state: State<'_, DesktopState>) -> CommandResult<BootstrapDto> {
    state
        .backend
        .bootstrap(&state.default_root)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn load_space(
    space_id: String,
    state: State<'_, DesktopState>,
) -> CommandResult<SpaceSnapshotDto> {
    state
        .backend
        .load_space(&space_id)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn list_agents(state: State<'_, DesktopState>) -> CommandResult<Vec<AgentSummaryDto>> {
    state.backend.list_agents().map_err(ApiErrorDto::from)
}

#[tauri::command]
pub async fn switch_space(
    space_id: String,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || backend.switch_space(&space_id).map_err(ApiErrorDto::from)).await
}

#[tauri::command]
pub fn create_space(
    request: CreateSpaceRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state
        .backend
        .create_space(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn rename_space(
    request: RenameSpaceRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state
        .backend
        .rename_space(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn delete_space(
    request: DeleteSpaceRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state
        .backend
        .delete_space(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn create_folder(
    request: CreateFolderRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state
        .backend
        .create_folder(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn rename_folder(
    request: RenameFolderRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state
        .backend
        .rename_folder(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn set_folder_collapsed(
    request: SetFolderCollapsedRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state
        .backend
        .set_folder_collapsed(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn delete_folder(
    request: DeleteFolderRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state
        .backend
        .delete_folder(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn move_space(
    request: MoveSpaceRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state.backend.move_space(request).map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn move_folder(
    request: MoveFolderRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<BootstrapDto> {
    state
        .backend
        .move_folder(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub async fn save_layout(
    request: SaveLayoutRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<SpaceLayoutDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || backend.save_layout(request).map_err(ApiErrorDto::from)).await
}

#[tauri::command]
pub fn update_tab_state(
    request: UpdateTabStateRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<TabDto> {
    state
        .backend
        .update_tab_state(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub async fn delete_tab(
    request: DeleteTabRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<TabDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || backend.delete_tab(request).map_err(ApiErrorDto::from)).await
}

#[tauri::command]
pub fn create_cli_tab(
    request: CreateCliTabRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<CreatedCliTabDto> {
    state
        .backend
        .create_cli_tab(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn create_browser_tab(
    request: CreateBrowserTabRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<TabDto> {
    state
        .backend
        .create_browser_tab(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn create_file_explorer_tab(
    request: CreateFileExplorerTabRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<TabDto> {
    state
        .backend
        .create_file_explorer_tab(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn create_file_editor_tab(
    request: CreateFileEditorTabRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<TabDto> {
    state
        .backend
        .create_file_editor_tab(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn create_git_tab(
    request: CreateGitTabRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<TabDto> {
    state
        .backend
        .create_git_tab(request)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn get_cli_session(
    cli_session_id: String,
    state: State<'_, DesktopState>,
) -> CommandResult<CliSessionDto> {
    state
        .backend
        .get_cli_session(&cli_session_id)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn replace_cli_session(
    request: ReplaceCliSessionRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<CliSessionDto> {
    state
        .backend
        .replace_cli_session(&request.cli_session_id)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub async fn list_directory(
    request: ListDirectoryRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<DirectoryListingDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || backend.list_directory(request).map_err(ApiErrorDto::from)).await
}

#[tauri::command]
pub async fn read_file(
    request: ReadFileRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<FileDocumentDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || backend.read_file(request).map_err(ApiErrorDto::from)).await
}

#[tauri::command]
pub async fn resolve_file_reference(
    request: ResolveFileReferenceRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<ResolvedFileReferenceDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || {
        backend
            .resolve_file_reference(request)
            .map_err(ApiErrorDto::from)
    })
    .await
}

#[tauri::command]
pub async fn write_file(
    request: WriteFileRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<WriteFileResultDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || backend.write_file(request).map_err(ApiErrorDto::from)).await
}

#[tauri::command]
pub fn browse_host_directory(
    request: BrowseHostDirectoryRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<HostDirectoryListingDto> {
    ccsm_platform::LocalFileSystemBackend::new()
        .browse_host_directory(
            request.path.as_deref(),
            &state.home_dir,
            workspace_root(&request),
        )
        .map(Into::into)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn create_host_directory(
    request: CreateHostDirectoryRequest,
) -> CommandResult<HostDirectoryEntryDto> {
    ccsm_platform::LocalFileSystemBackend::new()
        .create_host_directory(&request.parent_path, &request.name)
        .map(Into::into)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub async fn cached_git(
    space_id: String,
    state: State<'_, DesktopState>,
) -> CommandResult<GitSnapshotDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || backend.cached_git(&space_id).map_err(ApiErrorDto::from)).await
}

#[tauri::command]
pub async fn refresh_git(
    request: RefreshGitRequest,
    state: State<'_, DesktopState>,
) -> CommandResult<GitSnapshotDto> {
    let backend = Arc::clone(&state.backend);
    on_blocking_worker(move || backend.refresh_git(request).map_err(ApiErrorDto::from)).await
}

#[tauri::command]
pub fn start_runtime(
    request: StartRuntimeRequest,
    on_event: Channel<RuntimeEvent>,
    state: State<'_, DesktopState>,
) -> CommandResult<RuntimeStartedDto> {
    let sink: RuntimeEventSink = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    state
        .backend
        .start_runtime(request, sink)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn write_runtime(
    runtime_id: String,
    data: String,
    state: State<'_, DesktopState>,
) -> CommandResult<()> {
    state
        .backend
        .write_runtime(&runtime_id, data.into_bytes())
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn resize_runtime(
    runtime_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, DesktopState>,
) -> CommandResult<()> {
    state
        .backend
        .resize_runtime(&runtime_id, cols, rows)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub fn stop_runtime(runtime_id: String, state: State<'_, DesktopState>) -> CommandResult<()> {
    state
        .backend
        .stop_runtime(&runtime_id)
        .map_err(ApiErrorDto::from)
}

#[tauri::command]
pub async fn create_browser(
    window: Window,
    surface_id: String,
    bounds: BrowserBounds,
    url: String,
    state: State<'_, DesktopState>,
) -> Result<BrowserInfo, String> {
    state.browser.create(&window, &surface_id, bounds, &url)
}

#[tauri::command]
pub fn set_browser_bounds(
    app: AppHandle,
    surface_id: String,
    bounds: BrowserBounds,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state.browser.set_bounds(&app, &surface_id, bounds)
}

#[tauri::command]
pub fn set_browser_visible(
    app: AppHandle,
    surface_id: String,
    visible: bool,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state.browser.set_visible(&app, &surface_id, visible)
}

#[tauri::command]
pub async fn capture_browser(
    app: AppHandle,
    surface_id: String,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    state.browser.capture(&app, &surface_id).await
}

#[tauri::command]
pub fn focus_browser(
    app: AppHandle,
    surface_id: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state.browser.focus(&app, &surface_id)
}

#[tauri::command]
pub fn navigate_browser(
    app: AppHandle,
    surface_id: String,
    url: String,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    state.browser.navigate(&app, &surface_id, &url)
}

#[tauri::command]
pub fn reload_browser(
    app: AppHandle,
    surface_id: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state.browser.reload(&app, &surface_id)
}

#[tauri::command]
pub fn close_browser(
    app: AppHandle,
    surface_id: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state.browser.close(&app, &surface_id)
}
