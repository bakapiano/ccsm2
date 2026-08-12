use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

macro_rules! export_ts {
    (
        #[derive($($derive:tt)*)]
        $(#[$attribute:meta])*
        $visibility:vis $kind:ident $name:ident $($body:tt)*
    ) => {
        #[derive($($derive)*)]
        #[ts(export, export_to = "../../../apps/desktop/src/generated/")]
        $(#[$attribute])*
        $visibility $kind $name $($body)*
    };
}

export_ts! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "kebab-case")]
    pub enum TabKind {
        CliSession,
        Browser,
        FileExplorer,
        FileEditor,
        Git,
    }
}

export_ts! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "lowercase")]
    pub enum ProviderKind {
        Shell,
        Claude,
        Codex,
        Copilot,
    }
}

export_ts! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "snake_case")]
    pub enum NativeBindingState {
        NotApplicable,
        Pending,
        Bound,
        Unavailable,
    }
}

export_ts! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "lowercase")]
    pub enum DesiredState {
        Running,
        Stopped,
    }
}

export_ts! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "lowercase")]
    pub enum AgentActivity {
        Starting,
        Idle,
        Working,
        Blocked,
        Stopped,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct SpaceDto {
        pub id: String,
        pub name: String,
        pub icon: Option<String>,
        pub root_id: String,
        pub root_path: String,
        pub folder_id: Option<String>,
        pub folder_order: i32,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct SpaceFolderDto {
        pub id: String,
        pub parent_id: Option<String>,
        pub name: String,
        pub sort_order: i32,
        pub collapsed: bool,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct TabDto {
        pub id: String,
        pub space_id: String,
        pub kind: TabKind,
        pub title: String,
        pub resource_id: Option<String>,
        pub state_version: u32,
        #[ts(type = "unknown")]
        pub state: Value,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct SpaceLayoutDto {
        pub space_id: String,
        #[ts(type = "unknown")]
        pub dockview_snapshot: Option<Value>,
        pub active_tab_id: Option<String>,
        pub focused_group_id: Option<String>,
        pub layout_revision: u32,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CliSessionDto {
        pub id: String,
        pub space_id: String,
        pub provider: ProviderKind,
        pub cwd: String,
        pub native_session_id: Option<String>,
        pub native_binding_state: NativeBindingState,
        pub desired_state: DesiredState,
        pub last_exit_summary: Option<String>,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct AgentSummaryDto {
        pub cli_session_id: String,
        pub space_id: String,
        pub space_name: String,
        pub tab_id: String,
        pub tab_title: String,
        pub provider: ProviderKind,
        pub activity: AgentActivity,
        pub runtime_id: Option<String>,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct AgentActivityChangedDto {
        pub cli_session_id: String,
        pub runtime_id: String,
        pub activity: AgentActivity,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateCliTabRequest {
        pub space_id: String,
        pub provider: ProviderKind,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CreatedCliTabDto {
        pub tab: TabDto,
        pub cli_session: CliSessionDto,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateBrowserTabRequest {
        pub space_id: String,
        pub url: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateFileExplorerTabRequest {
        pub space_id: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateFileEditorTabRequest {
        pub space_id: String,
        pub relative_path: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateGitTabRequest {
        pub space_id: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct ReplaceCliSessionRequest {
        pub cli_session_id: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct NativeBindingDto {
        pub cli_session_id: String,
        pub provider: ProviderKind,
        pub native_session_id: Option<String>,
        pub native_binding_state: NativeBindingState,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct SpaceSnapshotDto {
        pub space: SpaceDto,
        pub tabs: Vec<TabDto>,
        pub layout: SpaceLayoutDto,
        pub cli_sessions: Vec<CliSessionDto>,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct BootstrapDto {
        pub spaces: Vec<SpaceDto>,
        pub folders: Vec<SpaceFolderDto>,
        pub active_space_id: String,
        pub active_snapshot: SpaceSnapshotDto,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateSpaceRequest {
        pub name: String,
        pub root_path: String,
        pub folder_id: Option<String>,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct RenameSpaceRequest {
        pub space_id: String,
        pub name: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct DeleteSpaceRequest {
        pub space_id: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct DeleteTabRequest {
        pub space_id: String,
        pub tab_id: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateFolderRequest {
        pub parent_id: Option<String>,
        pub name: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct RenameFolderRequest {
        pub folder_id: String,
        pub name: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct SetFolderCollapsedRequest {
        pub folder_id: String,
        pub collapsed: bool,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct DeleteFolderRequest {
        pub folder_id: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct MoveSpaceRequest {
        pub space_id: String,
        pub folder_id: Option<String>,
        pub order: i32,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct MoveFolderRequest {
        pub folder_id: String,
        pub parent_id: Option<String>,
        pub order: i32,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct ListDirectoryRequest {
        pub space_id: String,
        pub relative_path: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct ReadFileRequest {
        pub space_id: String,
        pub relative_path: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "kebab-case")]
    pub enum FileOpenStatus {
        Editable,
        ReadOnly,
        TooLarge,
        Binary,
        UnsupportedEncoding,
    }
}

export_ts! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "lowercase")]
    pub enum FileLineEnding {
        Lf,
        CrLf,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct FileDocumentDto {
        pub space_id: String,
        pub relative_path: String,
        pub content: Option<String>,
        pub status: FileOpenStatus,
        pub reason: Option<String>,
        pub size: f64,
        pub revision: Option<String>,
        pub utf8_bom: bool,
        pub line_ending: FileLineEnding,
        pub syntax_highlighting: bool,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct WriteFileRequest {
        pub space_id: String,
        pub relative_path: String,
        pub content: String,
        pub expected_revision: Option<String>,
        pub utf8_bom: bool,
        pub line_ending: FileLineEnding,
        pub overwrite: bool,
        pub recreate: bool,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct WriteFileResultDto {
        pub space_id: String,
        pub relative_path: String,
        pub revision: String,
        pub size: f64,
    }
}

export_ts! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "kebab-case")]
    pub enum FileEntryKind {
        Directory,
        File,
        Symlink,
        Other,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct FileEntryDto {
        pub name: String,
        pub relative_path: String,
        pub kind: FileEntryKind,
        pub size: Option<f64>,
        pub modified_at: Option<f64>,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct DirectoryListingDto {
        pub space_id: String,
        pub relative_path: String,
        pub entries: Vec<FileEntryDto>,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct FileChangeHintDto {
        pub root_id: String,
        pub relative_paths: Vec<String>,
        pub overflow: bool,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(tag = "kind", rename_all_fields = "camelCase")]
    pub enum AppEvent {
        #[serde(rename = "filesystem.changed")]
        FilesystemChanged { payload: FileChangeHintDto },
        #[serde(rename = "session.bindingChanged")]
        SessionBindingChanged { payload: NativeBindingDto },
        #[serde(rename = "agent.activityChanged")]
        AgentActivityChanged { payload: AgentActivityChangedDto },
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct RefreshGitRequest {
        pub space_id: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct GitFileChangeDto {
        pub path: String,
        pub original_path: Option<String>,
        pub index_status: String,
        pub worktree_status: String,
        pub kind: String,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct GitRepositoryStatusDto {
        pub repository_id: String,
        pub relative_path: String,
        pub root_path: String,
        pub branch: Option<String>,
        pub files: Vec<GitFileChangeDto>,
        pub captured_at: i64,
        pub error: Option<String>,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct GitSnapshotDto {
        pub space_id: String,
        pub root_id: String,
        pub scan_generation: u32,
        pub repositories: Vec<GitRepositoryStatusDto>,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct SaveLayoutRequest {
        pub space_id: String,
        #[ts(type = "unknown")]
        pub dockview_snapshot: Value,
        pub active_tab_id: Option<String>,
        pub focused_group_id: Option<String>,
        pub layout_revision: u32,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateTabStateRequest {
        pub tab_id: String,
        pub title: String,
        pub state_version: u32,
        #[ts(type = "unknown")]
        pub state: Value,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct StartRuntimeRequest {
        pub cli_session_id: String,
        pub cols: u16,
        pub rows: u16,
    }
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    pub struct RuntimeStartedDto {
        pub runtime_id: String,
        pub cli_session_id: String,
        pub pid: Option<u32>,
        pub provider: ProviderKind,
        pub native_binding_state: NativeBindingState,
        pub shell: String,
        pub engine: String,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookReport {
    pub provider: ProviderKind,
    pub cli_session_id: String,
    pub runtime_id: String,
    pub token: String,
    pub native_session_id: String,
    pub hook_event_name: String,
}

export_ts! {
    #[derive(Debug, Clone, Serialize, Deserialize, TS)]
    #[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum RuntimeEvent {
        Output { runtime_id: String, data: Vec<u8> },
        Error { runtime_id: String, message: String },
        Exit { runtime_id: String, code: u32 },
    }
}
