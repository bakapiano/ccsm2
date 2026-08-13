use std::{path::Path, sync::Arc};

use crate::{
    dto::{
        AgentSummaryDto, BootstrapDto, CliSessionDto, CreateBrowserTabRequest, CreateCliTabRequest,
        CreateFileEditorTabRequest, CreateFileExplorerTabRequest, CreateFolderRequest,
        CreateGitTabRequest, CreateSpaceRequest, CreatedCliTabDto, DeleteFolderRequest,
        DeleteSpaceRequest, DeleteTabRequest, DesiredState, FileDocumentDto, FileEntryDto,
        GitSnapshotDto, MoveFolderRequest, MoveSpaceRequest, ProviderKind, RenameFolderRequest,
        RenameSpaceRequest, ResolvedFileReferenceDto, SaveLayoutRequest, SetFolderCollapsedRequest,
        SpaceLayoutDto, SpaceSnapshotDto, TabDto, UpdateTabStateRequest, WriteFileRequest,
        WriteFileResultDto,
    },
    error::BackendResult,
};

pub trait StateStore: Send + Sync {
    fn bootstrap(&self, default_root: &Path) -> BackendResult<BootstrapDto>;
    fn workspace_state(&self) -> BackendResult<BootstrapDto>;
    fn load_space(&self, space_id: &str) -> BackendResult<SpaceSnapshotDto>;
    fn switch_space(&self, space_id: &str) -> BackendResult<BootstrapDto>;
    fn create_space(&self, request: CreateSpaceRequest) -> BackendResult<BootstrapDto>;
    fn rename_space(&self, request: RenameSpaceRequest) -> BackendResult<BootstrapDto>;
    fn delete_space(&self, request: DeleteSpaceRequest) -> BackendResult<BootstrapDto>;
    fn create_folder(&self, request: CreateFolderRequest) -> BackendResult<BootstrapDto>;
    fn rename_folder(&self, request: RenameFolderRequest) -> BackendResult<BootstrapDto>;
    fn set_folder_collapsed(
        &self,
        request: SetFolderCollapsedRequest,
    ) -> BackendResult<BootstrapDto>;
    fn delete_folder(&self, request: DeleteFolderRequest) -> BackendResult<BootstrapDto>;
    fn move_space(&self, request: MoveSpaceRequest) -> BackendResult<BootstrapDto>;
    fn move_folder(&self, request: MoveFolderRequest) -> BackendResult<BootstrapDto>;
    fn save_layout(&self, request: SaveLayoutRequest) -> BackendResult<SpaceLayoutDto>;
    fn update_tab_state(&self, request: UpdateTabStateRequest) -> BackendResult<TabDto>;
    fn get_tab(&self, tab_id: &str) -> BackendResult<TabDto>;
    fn delete_tab(&self, request: DeleteTabRequest) -> BackendResult<TabDto>;
    fn create_cli_tab(&self, request: CreateCliTabRequest) -> BackendResult<CreatedCliTabDto>;
    fn create_browser_tab(&self, request: CreateBrowserTabRequest) -> BackendResult<TabDto>;
    fn create_file_explorer_tab(
        &self,
        request: CreateFileExplorerTabRequest,
    ) -> BackendResult<TabDto>;
    fn create_file_editor_tab(&self, request: CreateFileEditorTabRequest) -> BackendResult<TabDto>;
    fn create_git_tab(&self, request: CreateGitTabRequest) -> BackendResult<TabDto>;
    fn get_cli_session(&self, session_id: &str) -> BackendResult<CliSessionDto>;
    fn list_agents(&self) -> BackendResult<Vec<AgentSummaryDto>> {
        Ok(Vec::new())
    }
    fn bind_native_session(
        &self,
        session_id: &str,
        provider: ProviderKind,
        native_session_id: &str,
    ) -> BackendResult<CliSessionDto>;
    fn mark_binding_unavailable_if_pending(
        &self,
        session_id: &str,
    ) -> BackendResult<Option<CliSessionDto>>;
    fn reset_cli_session_binding(&self, session_id: &str) -> BackendResult<CliSessionDto>;
    fn set_desired_state(&self, session_id: &str, desired_state: DesiredState)
    -> BackendResult<()>;
    fn cli_session_ids_for_space(&self, space_id: &str) -> BackendResult<Vec<String>>;
    fn space_root(&self, space_id: &str) -> BackendResult<RootDescriptor>;
    fn load_git_cache(&self, space_id: &str, root_id: &str) -> BackendResult<GitSnapshotDto>;
    fn save_git_cache(&self, snapshot: &GitSnapshotDto) -> BackendResult<()>;
}

#[derive(Debug, Clone)]
pub struct RootDescriptor {
    pub space_id: String,
    pub root_id: String,
    pub root_path: String,
}

pub trait FileSystemBackend: Send + Sync {
    fn resolve_file_reference(
        &self,
        root: &RootDescriptor,
        path: &str,
    ) -> BackendResult<ResolvedFileReferenceDto>;
    fn list_directory(
        &self,
        root: &RootDescriptor,
        relative_path: &str,
    ) -> BackendResult<Vec<FileEntryDto>>;
    fn read_file(
        &self,
        root: &RootDescriptor,
        relative_path: &str,
    ) -> BackendResult<FileDocumentDto>;
    fn write_file(
        &self,
        root: &RootDescriptor,
        request: &WriteFileRequest,
    ) -> BackendResult<WriteFileResultDto>;
}

pub trait GitBackend: Send + Sync {
    fn scan(&self, root: &RootDescriptor, scan_generation: u32) -> BackendResult<GitSnapshotDto>;
}

#[derive(Debug, Clone)]
pub struct FileWatchEvent {
    pub relative_paths: Vec<String>,
    pub overflow: bool,
}

pub type FileWatchEventSink = Arc<dyn Fn(FileWatchEvent) + Send + Sync + 'static>;

pub trait FileWatchHandle: Send + Sync {}

pub trait FileWatchBackend: Send + Sync {
    fn watch(
        &self,
        root: &RootDescriptor,
        sink: FileWatchEventSink,
    ) -> BackendResult<Box<dyn FileWatchHandle>>;
}

#[derive(Debug, Clone)]
pub struct PtySpawnSpec {
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub provider: ProviderKind,
    pub native_session_id: Option<String>,
    pub hook: Option<PtyHookContext>,
}

#[derive(Debug, Clone)]
pub struct PtyHookContext {
    pub cli_session_id: String,
    pub runtime_id: String,
    pub endpoint: String,
    pub token: String,
    pub reporter_path: String,
}

#[derive(Debug, Clone)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Error(String),
    Exit(u32),
}

pub type PtyEventSink = Arc<dyn Fn(PtyEvent) + Send + Sync + 'static>;

pub trait PtyProcess: Send + Sync {
    fn pid(&self) -> Option<u32>;
    fn shell_label(&self) -> &str;
    fn engine_label(&self) -> &str;
    fn write(&self, data: Vec<u8>) -> BackendResult<()>;
    fn resize(&self, cols: u16, rows: u16) -> BackendResult<()>;
    fn stop(&self) -> BackendResult<()>;
    fn shutdown(&self) -> BackendResult<()> {
        self.stop()
    }
}

pub trait PtyBackend: Send + Sync {
    fn spawn(
        &self,
        spec: PtySpawnSpec,
        event_sink: PtyEventSink,
    ) -> BackendResult<Arc<dyn PtyProcess>>;
}
