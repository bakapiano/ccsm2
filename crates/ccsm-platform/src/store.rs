use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use ccsm_core::{
    dto::{
        AgentActivity, AgentSummaryDto, BootstrapDto, CliSessionDto, CreateBrowserTabRequest,
        CreateCliTabRequest, CreateFileEditorTabRequest, CreateFileExplorerTabRequest,
        CreateFolderRequest, CreateGitTabRequest, CreateSpaceRequest, CreatedCliTabDto,
        DeleteFolderRequest, DeleteSpaceRequest, DeleteTabRequest, DesiredState,
        GitRepositoryStatusDto, GitSnapshotDto, MoveFolderRequest, MoveSpaceRequest,
        NativeBindingState, ProviderKind, RenameFolderRequest, RenameSpaceRequest,
        SaveLayoutRequest, SetFolderCollapsedRequest, SpaceDto, SpaceFolderDto, SpaceLayoutDto,
        SpaceSnapshotDto, TabDto, TabKind, UpdateTabStateRequest,
    },
    error::{BackendError, BackendResult},
    ports::{RootDescriptor, StateStore},
};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

pub struct SqliteStateStore {
    connection: Mutex<Connection>,
}

impl SqliteStateStore {
    pub fn open(path: &Path) -> BackendResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| BackendError::Storage(error.to_string()))?;
        }
        let mut connection = Connection::open(path).map_err(storage_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage_error)?;
        connection
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                PRAGMA synchronous = FULL;

                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS space_roots (
                    id TEXT PRIMARY KEY,
                    display_path TEXT NOT NULL,
                    real_path TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS space_folders (
                    id TEXT PRIMARY KEY,
                    parent_id TEXT REFERENCES space_folders(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    collapsed INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS spaces (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    icon TEXT,
                    folder_id TEXT REFERENCES space_folders(id) ON DELETE SET NULL,
                    folder_order INTEGER NOT NULL DEFAULT 0,
                    root_id TEXT NOT NULL REFERENCES space_roots(id),
                    archived_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS tabs (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    resource_id TEXT,
                    state_version INTEGER NOT NULL,
                    state_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS tabs_cli_resource_unique
                    ON tabs(resource_id)
                    WHERE kind = 'cli-session' AND resource_id IS NOT NULL;
                CREATE UNIQUE INDEX IF NOT EXISTS tabs_git_space_unique
                    ON tabs(space_id)
                    WHERE kind = 'git';
                CREATE UNIQUE INDEX IF NOT EXISTS tabs_file_editor_path_unique
                    ON tabs(space_id, resource_id)
                    WHERE kind = 'file-editor' AND resource_id IS NOT NULL;

                CREATE TABLE IF NOT EXISTS space_layouts (
                    space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
                    dockview_snapshot TEXT,
                    active_tab_id TEXT,
                    focused_group_id TEXT,
                    layout_revision INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS cli_sessions (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    native_session_id TEXT,
                    native_binding_state TEXT NOT NULL,
                    desired_state TEXT NOT NULL,
                    last_exit_summary TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS cli_native_session_unique
                    ON cli_sessions(provider, native_session_id)
                    WHERE native_session_id IS NOT NULL;

                CREATE TABLE IF NOT EXISTS git_repositories_cache (
                    repository_id TEXT PRIMARY KEY,
                    root_id TEXT NOT NULL REFERENCES space_roots(id) ON DELETE CASCADE,
                    relative_path TEXT NOT NULL,
                    real_path TEXT NOT NULL,
                    scanned_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS git_status_cache (
                    repository_id TEXT PRIMARY KEY REFERENCES git_repositories_cache(repository_id) ON DELETE CASCADE,
                    snapshot_json TEXT NOT NULL,
                    captured_at INTEGER NOT NULL
                );
                "#,
            )
            .map_err(storage_error)?;
        connection
            .execute(
                "UPDATE cli_sessions
                 SET native_binding_state = 'unavailable', updated_at = ?1
                 WHERE provider <> 'shell' AND native_binding_state = 'pending'",
                [now_timestamp()],
            )
            .map_err(storage_error)?;
        connection
            .execute(
                "UPDATE spaces SET archived_at = NULL, updated_at = ?1
                 WHERE archived_at IS NOT NULL",
                [now_timestamp()],
            )
            .map_err(storage_error)?;
        normalize_stored_windows_paths(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn connection(&self) -> BackendResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| BackendError::Storage("data.db connection lock poisoned".into()))
    }
}

impl StateStore for SqliteStateStore {
    fn bootstrap(&self, default_root: &Path) -> BackendResult<BootstrapDto> {
        let mut connection = self.connection()?;
        if count_spaces(&connection)? == 0 {
            create_default_space(&mut connection, default_root)?;
        }
        workspace_state_from_connection(&connection)
    }

    fn workspace_state(&self) -> BackendResult<BootstrapDto> {
        let connection = self.connection()?;
        workspace_state_from_connection(&connection)
    }

    fn load_space(&self, space_id: &str) -> BackendResult<SpaceSnapshotDto> {
        let connection = self.connection()?;
        load_space_from_connection(&connection, space_id)
    }

    fn switch_space(&self, space_id: &str) -> BackendResult<BootstrapDto> {
        let connection = self.connection()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?1)",
                [space_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            return Err(BackendError::NotFound(format!("space {space_id}")));
        }
        set_active_space(&connection, space_id)?;
        workspace_state_from_connection(&connection)
    }

    fn create_space(&self, request: CreateSpaceRequest) -> BackendResult<BootstrapDto> {
        let name = validated_name(&request.name, "Space")?;
        let requested_root = Path::new(&request.root_path);
        if !requested_root.is_dir() {
            return Err(BackendError::Invalid(format!(
                "Space root is not a directory: {}",
                requested_root.display()
            )));
        }
        let root = requested_root
            .canonicalize()
            .map_err(|error| BackendError::Invalid(format!("canonicalize Space root: {error}")))?;
        let root_path = persisted_path(&root);
        let real_path = root.to_string_lossy().into_owned();
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        ensure_folder_exists(&transaction, request.folder_id.as_deref())?;
        let root_id = transaction
            .query_row(
                "SELECT id FROM space_roots WHERE real_path = ?1",
                [&real_path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        transaction
            .execute(
                "INSERT OR IGNORE INTO space_roots(id, display_path, real_path, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![root_id, root_path, real_path, now_timestamp()],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE space_roots SET display_path = ?2, updated_at = ?3 WHERE id = ?1",
                params![root_id, root_path, now_timestamp()],
            )
            .map_err(storage_error)?;
        let order = next_space_order(&transaction, request.folder_id.as_deref())?;
        let space_id = insert_space_graph(
            &transaction,
            &root_id,
            &root_path,
            &name,
            request.folder_id.as_deref(),
            order,
        )?;
        set_active_space(&transaction, &space_id)?;
        transaction.commit().map_err(storage_error)?;
        workspace_state_from_connection(&connection)
    }

    fn rename_space(&self, request: RenameSpaceRequest) -> BackendResult<BootstrapDto> {
        let name = validated_name(&request.name, "Space")?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE spaces SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![request.space_id, name, now_timestamp()],
            )
            .map_err(storage_error)?;
        ensure_changed(changed, "Space", &request.space_id)?;
        workspace_state_from_connection(&connection)
    }

    fn delete_space(&self, request: DeleteSpaceRequest) -> BackendResult<BootstrapDto> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        let root_id: String = transaction
            .query_row(
                "SELECT root_id FROM spaces WHERE id = ?1",
                [&request.space_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| BackendError::NotFound(format!("Space {}", request.space_id)))?;
        let active_id = active_space_id(&transaction)?;
        if active_id == request.space_id {
            let replacement =
                first_space(&transaction, Some(&request.space_id))?.ok_or_else(|| {
                    BackendError::Conflict("cannot delete the last active Space".into())
                })?;
            set_active_space(&transaction, &replacement)?;
        }
        transaction
            .execute("DELETE FROM spaces WHERE id = ?1", [&request.space_id])
            .map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM space_roots
                 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM spaces WHERE root_id = ?1)",
                [&root_id],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        workspace_state_from_connection(&connection)
    }

    fn create_folder(&self, request: CreateFolderRequest) -> BackendResult<BootstrapDto> {
        let name = validated_name(&request.name, "Folder")?;
        let connection = self.connection()?;
        ensure_folder_exists(&connection, request.parent_id.as_deref())?;
        if let Some(parent_id) = request.parent_id.as_deref()
            && folder_depth(&connection, parent_id)? >= 32
        {
            return Err(BackendError::Invalid(
                "Folder tree depth cannot exceed 32".into(),
            ));
        }
        let id = Uuid::new_v4().to_string();
        let order = next_folder_order(&connection, request.parent_id.as_deref())?;
        let now = now_timestamp();
        connection
            .execute(
                "INSERT INTO space_folders(id, parent_id, name, sort_order, collapsed, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
                params![id, request.parent_id, name, order, now],
            )
            .map_err(storage_error)?;
        workspace_state_from_connection(&connection)
    }

    fn rename_folder(&self, request: RenameFolderRequest) -> BackendResult<BootstrapDto> {
        let name = validated_name(&request.name, "Folder")?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE space_folders SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![request.folder_id, name, now_timestamp()],
            )
            .map_err(storage_error)?;
        ensure_changed(changed, "Folder", &request.folder_id)?;
        workspace_state_from_connection(&connection)
    }

    fn set_folder_collapsed(
        &self,
        request: SetFolderCollapsedRequest,
    ) -> BackendResult<BootstrapDto> {
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE space_folders SET collapsed = ?2, updated_at = ?3 WHERE id = ?1",
                params![request.folder_id, request.collapsed, now_timestamp()],
            )
            .map_err(storage_error)?;
        ensure_changed(changed, "Folder", &request.folder_id)?;
        workspace_state_from_connection(&connection)
    }

    fn delete_folder(&self, request: DeleteFolderRequest) -> BackendResult<BootstrapDto> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        let parent_id: Option<String> = transaction
            .query_row(
                "SELECT parent_id FROM space_folders WHERE id = ?1",
                [&request.folder_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| BackendError::NotFound(format!("Folder {}", request.folder_id)))?;
        let mut folder_order = next_folder_order(&transaction, parent_id.as_deref())?;
        let child_folders = query_ids(
            &transaction,
            "SELECT id FROM space_folders WHERE parent_id IS ?1 ORDER BY sort_order",
            &request.folder_id,
        )?;
        for child_id in child_folders {
            transaction
                .execute(
                    "UPDATE space_folders SET parent_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
                    params![child_id, parent_id, folder_order, now_timestamp()],
                )
                .map_err(storage_error)?;
            folder_order += 1;
        }
        let mut space_order = next_space_order(&transaction, parent_id.as_deref())?;
        let child_spaces = query_ids(
            &transaction,
            "SELECT id FROM spaces WHERE folder_id = ?1 ORDER BY folder_order",
            &request.folder_id,
        )?;
        for space_id in child_spaces {
            transaction
                .execute(
                    "UPDATE spaces SET folder_id = ?2, folder_order = ?3, updated_at = ?4 WHERE id = ?1",
                    params![space_id, parent_id, space_order, now_timestamp()],
                )
                .map_err(storage_error)?;
            space_order += 1;
        }
        transaction
            .execute(
                "DELETE FROM space_folders WHERE id = ?1",
                [&request.folder_id],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        workspace_state_from_connection(&connection)
    }

    fn move_space(&self, request: MoveSpaceRequest) -> BackendResult<BootstrapDto> {
        let connection = self.connection()?;
        ensure_folder_exists(&connection, request.folder_id.as_deref())?;
        let changed = connection
            .execute(
                "UPDATE spaces SET folder_id = ?2, folder_order = ?3, updated_at = ?4 WHERE id = ?1",
                params![request.space_id, request.folder_id, request.order, now_timestamp()],
            )
            .map_err(storage_error)?;
        ensure_changed(changed, "Space", &request.space_id)?;
        workspace_state_from_connection(&connection)
    }

    fn move_folder(&self, request: MoveFolderRequest) -> BackendResult<BootstrapDto> {
        if request.parent_id.as_deref() == Some(request.folder_id.as_str()) {
            return Err(BackendError::Invalid("Folder cannot contain itself".into()));
        }
        let connection = self.connection()?;
        ensure_folder_exists(&connection, request.parent_id.as_deref())?;
        let descendant = match request.parent_id.as_deref() {
            Some(parent_id) => folder_is_descendant(&connection, &request.folder_id, parent_id)?,
            None => false,
        };
        if descendant {
            return Err(BackendError::Invalid(
                "Folder cannot move into one of its descendants".into(),
            ));
        }
        let parent_depth = match request.parent_id.as_deref() {
            Some(parent_id) => folder_depth(&connection, parent_id)?,
            None => 0,
        };
        if parent_depth + folder_subtree_height(&connection, &request.folder_id)? > 32 {
            return Err(BackendError::Invalid(
                "Folder tree depth cannot exceed 32".into(),
            ));
        }
        let changed = connection
            .execute(
                "UPDATE space_folders SET parent_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
                params![request.folder_id, request.parent_id, request.order, now_timestamp()],
            )
            .map_err(storage_error)?;
        ensure_changed(changed, "Folder", &request.folder_id)?;
        workspace_state_from_connection(&connection)
    }

    fn save_layout(&self, request: SaveLayoutRequest) -> BackendResult<SpaceLayoutDto> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        let current = load_layout(&transaction, &request.space_id)?;
        if request.layout_revision > current.layout_revision {
            let snapshot = serde_json::to_string(&request.dockview_snapshot)
                .map_err(|error| BackendError::Storage(error.to_string()))?;
            transaction
                .execute(
                    "UPDATE space_layouts
                     SET dockview_snapshot = ?2, active_tab_id = ?3, focused_group_id = ?4,
                         layout_revision = ?5, updated_at = ?6
                     WHERE space_id = ?1",
                    params![
                        request.space_id,
                        snapshot,
                        request.active_tab_id,
                        request.focused_group_id,
                        request.layout_revision,
                        now_timestamp(),
                    ],
                )
                .map_err(storage_error)?;
        }
        let result = load_layout(&transaction, &request.space_id)?;
        transaction.commit().map_err(storage_error)?;
        Ok(result)
    }

    fn update_tab_state(&self, request: UpdateTabStateRequest) -> BackendResult<TabDto> {
        let state_json = serde_json::to_string(&request.state)
            .map_err(|error| BackendError::Storage(error.to_string()))?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE tabs SET title = ?2, state_version = ?3, state_json = ?4, updated_at = ?5
                 WHERE id = ?1",
                params![
                    request.tab_id,
                    request.title,
                    request.state_version,
                    state_json,
                    now_timestamp(),
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(BackendError::NotFound(format!("tab {}", request.tab_id)));
        }
        load_tab(&connection, &request.tab_id)
    }

    fn get_tab(&self, tab_id: &str) -> BackendResult<TabDto> {
        let connection = self.connection()?;
        load_tab(&connection, tab_id)
    }

    fn delete_tab(&self, request: DeleteTabRequest) -> BackendResult<TabDto> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        let tab = load_tab(&transaction, &request.tab_id)?;
        if tab.space_id != request.space_id {
            return Err(BackendError::Conflict(
                "Tab does not belong to the requested Space".into(),
            ));
        }
        let changed = transaction
            .execute(
                "DELETE FROM tabs WHERE id = ?1 AND space_id = ?2",
                params![request.tab_id, request.space_id],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(BackendError::NotFound(format!("tab {}", request.tab_id)));
        }
        if tab.kind == TabKind::CliSession
            && let Some(session_id) = tab.resource_id.as_deref()
        {
            transaction
                .execute(
                    "DELETE FROM cli_sessions WHERE id = ?1 AND space_id = ?2",
                    params![session_id, request.space_id],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(tab)
    }

    fn create_cli_tab(&self, request: CreateCliTabRequest) -> BackendResult<CreatedCliTabDto> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        let cwd: String = transaction
            .query_row(
                "SELECT r.display_path
                 FROM spaces s JOIN space_roots r ON r.id = s.root_id
                 WHERE s.id = ?1",
                [&request.space_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| BackendError::NotFound(format!("Space {}", request.space_id)))?;
        let session_id = Uuid::new_v4().to_string();
        let tab_id = Uuid::new_v4().to_string();
        let binding_state = match request.provider {
            ProviderKind::Shell => "not_applicable",
            ProviderKind::Claude | ProviderKind::Codex => "pending",
        };
        let now = now_timestamp();
        transaction
            .execute(
                "INSERT INTO cli_sessions(
                    id, space_id, provider, cwd, native_binding_state, desired_state,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?6)",
                params![
                    session_id,
                    request.space_id,
                    provider_text(request.provider),
                    cwd,
                    binding_state,
                    now,
                ],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "INSERT INTO tabs(
                    id, space_id, kind, title, resource_id, state_version, state_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, 'cli-session', ?3, ?4, 1, '{}', ?5, ?5)",
                params![
                    tab_id,
                    request.space_id,
                    provider_title(request.provider),
                    session_id,
                    now,
                ],
            )
            .map_err(storage_error)?;
        let tab = load_tab(&transaction, &tab_id)?;
        let cli_session = load_cli_session(&transaction, &session_id)?;
        transaction.commit().map_err(storage_error)?;
        Ok(CreatedCliTabDto { tab, cli_session })
    }

    fn create_browser_tab(&self, request: CreateBrowserTabRequest) -> BackendResult<TabDto> {
        if request.url.len() > 8192
            || !(request.url.starts_with("https://")
                || request.url.starts_with("http://")
                || request.url.starts_with("about:"))
        {
            return Err(BackendError::Invalid("Browser URL is not allowed".into()));
        }
        let connection = self.connection()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?1)",
                [&request.space_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            return Err(BackendError::NotFound(format!(
                "Space {}",
                request.space_id
            )));
        }
        let tab_id = Uuid::new_v4().to_string();
        let state = serde_json::to_string(&serde_json::json!({
            "lastUrl": request.url,
            "zoom": 1
        }))
        .map_err(|error| BackendError::Storage(error.to_string()))?;
        let now = now_timestamp();
        connection
            .execute(
                "INSERT INTO tabs(
                    id, space_id, kind, title, resource_id, state_version, state_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, 'browser', 'Browser', ?1, 1, ?3, ?4, ?4)",
                params![tab_id, request.space_id, state, now],
            )
            .map_err(storage_error)?;
        load_tab(&connection, &tab_id)
    }

    fn create_file_explorer_tab(
        &self,
        request: CreateFileExplorerTabRequest,
    ) -> BackendResult<TabDto> {
        let connection = self.connection()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?1)",
                [&request.space_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            return Err(BackendError::NotFound(format!(
                "Space {}",
                request.space_id
            )));
        }
        let tab_id = Uuid::new_v4().to_string();
        let now = now_timestamp();
        connection
            .execute(
                "INSERT INTO tabs(
                    id, space_id, kind, title, resource_id, state_version, state_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, 'file-explorer', 'Files', ?2, 1, ?3, ?4, ?4)",
                params![
                    tab_id,
                    request.space_id,
                    r#"{"rootRelativePath":"","expandedPaths":[],"selectedPath":null}"#,
                    now,
                ],
            )
            .map_err(storage_error)?;
        load_tab(&connection, &tab_id)
    }

    fn create_file_editor_tab(&self, request: CreateFileEditorTabRequest) -> BackendResult<TabDto> {
        let relative_path = normalized_editor_path(&request.relative_path)?;
        let title = relative_path
            .rsplit('/')
            .next()
            .ok_or_else(|| BackendError::Invalid("file path must name a file".into()))?;
        let connection = self.connection()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?1)",
                [&request.space_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            return Err(BackendError::NotFound(format!(
                "Space {}",
                request.space_id
            )));
        }
        if let Some(existing_id) = connection
            .query_row(
                "SELECT id FROM tabs
                 WHERE space_id = ?1 AND kind = 'file-editor' AND resource_id = ?2",
                params![request.space_id, relative_path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
        {
            return load_tab(&connection, &existing_id);
        }
        let tab_id = Uuid::new_v4().to_string();
        let state = serde_json::to_string(&serde_json::json!({
            "relativePath": relative_path,
            "selectionAnchor": 0,
            "selectionHead": 0,
            "scrollTop": 0,
            "wordWrap": false
        }))
        .map_err(|error| BackendError::Storage(error.to_string()))?;
        let now = now_timestamp();
        connection
            .execute(
                "INSERT INTO tabs(
                    id, space_id, kind, title, resource_id, state_version, state_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, 'file-editor', ?3, ?4, 1, ?5, ?6, ?6)",
                params![tab_id, request.space_id, title, relative_path, state, now],
            )
            .map_err(storage_error)?;
        load_tab(&connection, &tab_id)
    }

    fn create_git_tab(&self, request: CreateGitTabRequest) -> BackendResult<TabDto> {
        let connection = self.connection()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?1)",
                [&request.space_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            return Err(BackendError::NotFound(format!(
                "Space {}",
                request.space_id
            )));
        }
        let tab_id = Uuid::new_v4().to_string();
        let now = now_timestamp();
        connection
            .execute(
                "INSERT INTO tabs(
                    id, space_id, kind, title, resource_id, state_version, state_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, 'git', 'Git', ?2, 1, ?3, ?4, ?4)",
                params![
                    tab_id,
                    request.space_id,
                    r#"{"collapsedRepositoryIds":[]}"#,
                    now,
                ],
            )
            .map_err(storage_error)?;
        load_tab(&connection, &tab_id)
    }

    fn get_cli_session(&self, session_id: &str) -> BackendResult<CliSessionDto> {
        let connection = self.connection()?;
        load_cli_session(&connection, session_id)
    }

    fn list_agents(&self) -> BackendResult<Vec<AgentSummaryDto>> {
        let connection = self.connection()?;
        list_agents(&connection)
    }

    fn bind_native_session(
        &self,
        session_id: &str,
        provider: ProviderKind,
        native_session_id: &str,
    ) -> BackendResult<CliSessionDto> {
        let connection = self.connection()?;
        let session = load_cli_session(&connection, session_id)?;
        if session.provider != provider || provider == ProviderKind::Shell {
            return Err(BackendError::Conflict(
                "Hook provider does not match the CLI Session".into(),
            ));
        }
        let owner = connection
            .query_row(
                "SELECT id FROM cli_sessions
                 WHERE provider = ?1 AND native_session_id = ?2 AND id <> ?3",
                params![provider_text(provider), native_session_id, session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        if owner.is_some() {
            return Err(BackendError::Conflict(
                "native Session is already bound to another CLI Session".into(),
            ));
        }
        connection
            .execute(
                "UPDATE cli_sessions
                 SET native_session_id = ?2, native_binding_state = 'bound', updated_at = ?3
                 WHERE id = ?1",
                params![session_id, native_session_id, now_timestamp()],
            )
            .map_err(storage_error)?;
        load_cli_session(&connection, session_id)
    }

    fn mark_binding_unavailable_if_pending(
        &self,
        session_id: &str,
    ) -> BackendResult<Option<CliSessionDto>> {
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE cli_sessions
                 SET native_binding_state = 'unavailable', updated_at = ?2
                 WHERE id = ?1 AND native_binding_state = 'pending'",
                params![session_id, now_timestamp()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Ok(None);
        }
        load_cli_session(&connection, session_id).map(Some)
    }

    fn reset_cli_session_binding(&self, session_id: &str) -> BackendResult<CliSessionDto> {
        let connection = self.connection()?;
        let session = load_cli_session(&connection, session_id)?;
        let binding_state = match session.provider {
            ProviderKind::Shell => "not_applicable",
            ProviderKind::Claude | ProviderKind::Codex => "pending",
        };
        connection
            .execute(
                "UPDATE cli_sessions
                 SET native_session_id = NULL, native_binding_state = ?2,
                     desired_state = 'running', last_exit_summary = NULL, updated_at = ?3
                 WHERE id = ?1",
                params![session_id, binding_state, now_timestamp()],
            )
            .map_err(storage_error)?;
        load_cli_session(&connection, session_id)
    }

    fn set_desired_state(
        &self,
        session_id: &str,
        desired_state: DesiredState,
    ) -> BackendResult<()> {
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE cli_sessions SET desired_state = ?2, updated_at = ?3 WHERE id = ?1",
                params![
                    session_id,
                    desired_state_text(desired_state),
                    now_timestamp()
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(BackendError::NotFound(format!("CLI session {session_id}")));
        }
        Ok(())
    }

    fn cli_session_ids_for_space(&self, space_id: &str) -> BackendResult<Vec<String>> {
        let connection = self.connection()?;
        query_ids(
            &connection,
            "SELECT id FROM cli_sessions WHERE space_id = ?1",
            space_id,
        )
    }

    fn space_root(&self, space_id: &str) -> BackendResult<RootDescriptor> {
        self.connection()?
            .query_row(
                "SELECT s.id, r.id, r.display_path
                 FROM spaces s JOIN space_roots r ON r.id = s.root_id
                 WHERE s.id = ?1",
                [space_id],
                |row| {
                    Ok(RootDescriptor {
                        space_id: row.get(0)?,
                        root_id: row.get(1)?,
                        root_path: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| BackendError::NotFound(format!("Space {space_id}")))
    }

    fn load_git_cache(&self, space_id: &str, root_id: &str) -> BackendResult<GitSnapshotDto> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT s.snapshot_json
                 FROM git_repositories_cache r
                 JOIN git_status_cache s ON s.repository_id = r.repository_id
                 WHERE r.root_id = ?1 ORDER BY r.relative_path",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([root_id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        let repositories = rows
            .map(|row| {
                let json = row.map_err(storage_error)?;
                serde_json::from_str::<GitRepositoryStatusDto>(&json)
                    .map_err(|error| BackendError::Storage(error.to_string()))
            })
            .collect::<BackendResult<Vec<_>>>()?;
        Ok(GitSnapshotDto {
            space_id: space_id.to_string(),
            root_id: root_id.to_string(),
            scan_generation: 0,
            repositories,
        })
    }

    fn save_git_cache(&self, snapshot: &GitSnapshotDto) -> BackendResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM git_repositories_cache WHERE root_id = ?1",
                [&snapshot.root_id],
            )
            .map_err(storage_error)?;
        let scanned_at = now_timestamp();
        for repository in &snapshot.repositories {
            transaction
                .execute(
                    "INSERT INTO git_repositories_cache(
                        repository_id, root_id, relative_path, real_path, scanned_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        repository.repository_id,
                        snapshot.root_id,
                        repository.relative_path,
                        repository.root_path,
                        scanned_at,
                    ],
                )
                .map_err(storage_error)?;
            let json = serde_json::to_string(repository)
                .map_err(|error| BackendError::Storage(error.to_string()))?;
            transaction
                .execute(
                    "INSERT INTO git_status_cache(repository_id, snapshot_json, captured_at)
                     VALUES (?1, ?2, ?3)",
                    params![repository.repository_id, json, repository.captured_at],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)
    }
}

fn create_default_space(connection: &mut Connection, default_root: &Path) -> BackendResult<()> {
    let root = default_root
        .canonicalize()
        .unwrap_or_else(|_| default_root.to_path_buf());
    let root_path = persisted_path(&root);
    let real_path = root.to_string_lossy().into_owned();
    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Workspace")
        .to_string();
    let root_id = Uuid::new_v4().to_string();
    let now = now_timestamp();
    let transaction = connection.transaction().map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO space_roots(id, display_path, real_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![root_id, root_path, real_path, now],
        )
        .map_err(storage_error)?;
    let space_id = insert_space_graph(&transaction, &root_id, &root_path, &root_name, None, 0)?;
    set_active_space(&transaction, &space_id)?;
    transaction.commit().map_err(storage_error)
}

fn insert_space_graph(
    transaction: &rusqlite::Transaction<'_>,
    root_id: &str,
    root_path: &str,
    name: &str,
    folder_id: Option<&str>,
    folder_order: i32,
) -> BackendResult<String> {
    let space_id = Uuid::new_v4().to_string();
    let session_id = Uuid::new_v4().to_string();
    let terminal_tab_id = Uuid::new_v4().to_string();
    let browser_tab_id = Uuid::new_v4().to_string();
    let file_tab_id = Uuid::new_v4().to_string();
    let git_tab_id = Uuid::new_v4().to_string();
    let now = now_timestamp();
    transaction
        .execute(
            "INSERT INTO spaces(id, name, folder_id, folder_order, root_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![space_id, name, folder_id, folder_order, root_id, now],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO cli_sessions(
                id, space_id, provider, cwd, native_binding_state, desired_state, created_at, updated_at
             ) VALUES (?1, ?2, 'shell', ?3, 'not_applicable', 'running', ?4, ?4)",
            params![session_id, space_id, root_path, now],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO tabs(
                id, space_id, kind, title, resource_id, state_version, state_json, created_at, updated_at
             ) VALUES (?1, ?2, 'cli-session', 'Shell', ?3, 1, '{}', ?4, ?4)",
            params![terminal_tab_id, space_id, session_id, now],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO tabs(
                id, space_id, kind, title, resource_id, state_version, state_json, created_at, updated_at
             ) VALUES (?1, ?2, 'browser', 'Browser', ?1, 1, ?3, ?4, ?4)",
            params![
                browser_tab_id,
                space_id,
                r#"{"lastUrl":"https://example.com/","zoom":1}"#,
                now,
            ],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO space_layouts(space_id, layout_revision, updated_at)
             VALUES (?1, 0, ?2)",
            params![space_id, now],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO tabs(
                id, space_id, kind, title, resource_id, state_version, state_json, created_at, updated_at
             ) VALUES (?1, ?2, 'file-explorer', 'Files', ?2, 1, ?3, ?4, ?4)",
            params![
                file_tab_id,
                space_id,
                r#"{"rootRelativePath":"","expandedPaths":[],"selectedPath":null}"#,
                now,
            ],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO tabs(
                id, space_id, kind, title, resource_id, state_version, state_json, created_at, updated_at
             ) VALUES (?1, ?2, 'git', 'Git', ?2, 1, ?3, ?4, ?4)",
            params![
                git_tab_id,
                space_id,
                r#"{"collapsedRepositoryIds":[]}"#,
                now,
            ],
        )
        .map_err(storage_error)?;
    Ok(space_id)
}

fn count_spaces(connection: &Connection) -> BackendResult<i64> {
    connection
        .query_row("SELECT COUNT(*) FROM spaces", [], |row| row.get(0))
        .map_err(storage_error)
}

fn workspace_state_from_connection(connection: &Connection) -> BackendResult<BootstrapDto> {
    let spaces = list_spaces(connection)?;
    let folders = list_folders(connection)?;
    let configured = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_active_space_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?;
    let active_space_id = configured
        .filter(|id| spaces.iter().any(|space| &space.id == id))
        .or_else(|| spaces.first().map(|space| space.id.clone()))
        .ok_or_else(|| BackendError::Conflict("workspace has no active Space".into()))?;
    set_active_space(connection, &active_space_id)?;
    let active_snapshot = load_space_from_connection(connection, &active_space_id)?;
    Ok(BootstrapDto {
        spaces,
        folders,
        active_space_id,
        active_snapshot,
    })
}

fn list_folders(connection: &Connection) -> BackendResult<Vec<SpaceFolderDto>> {
    let mut statement = connection
        .prepare(
            "SELECT id, parent_id, name, sort_order, collapsed
             FROM space_folders ORDER BY sort_order, created_at",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(SpaceFolderDto {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                sort_order: row.get(3)?,
                collapsed: row.get(4)?,
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn active_space_id(connection: &Connection) -> BackendResult<String> {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_active_space_id'",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn set_active_space(connection: &Connection, space_id: &str) -> BackendResult<()> {
    connection
        .execute(
            "INSERT INTO settings(key, value) VALUES ('last_active_space_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [space_id],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn first_space(connection: &Connection, excluding: Option<&str>) -> BackendResult<Option<String>> {
    connection
        .query_row(
            "SELECT id FROM spaces
             WHERE (?1 IS NULL OR id <> ?1)
             ORDER BY folder_order, created_at LIMIT 1",
            [excluding],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)
}

fn validated_name(value: &str, kind: &str) -> BackendResult<String> {
    let name = value.trim();
    if name.is_empty() {
        return Err(BackendError::Invalid(format!(
            "{kind} name cannot be empty"
        )));
    }
    if name.chars().count() > 120 {
        return Err(BackendError::Invalid(format!(
            "{kind} name cannot exceed 120 characters"
        )));
    }
    Ok(name.to_string())
}

fn ensure_folder_exists(connection: &Connection, folder_id: Option<&str>) -> BackendResult<()> {
    let Some(folder_id) = folder_id else {
        return Ok(());
    };
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM space_folders WHERE id = ?1)",
            [folder_id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if exists {
        Ok(())
    } else {
        Err(BackendError::NotFound(format!("Folder {folder_id}")))
    }
}

fn next_folder_order(connection: &Connection, parent_id: Option<&str>) -> BackendResult<i32> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM space_folders WHERE parent_id IS ?1",
            [parent_id],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn next_space_order(connection: &Connection, folder_id: Option<&str>) -> BackendResult<i32> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(folder_order) + 1, 0) FROM spaces WHERE folder_id IS ?1",
            [folder_id],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn query_ids(connection: &Connection, sql: &str, value: &str) -> BackendResult<Vec<String>> {
    let mut statement = connection.prepare(sql).map_err(storage_error)?;
    let rows = statement
        .query_map([value], |row| row.get::<_, String>(0))
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn folder_is_descendant(
    connection: &Connection,
    folder_id: &str,
    candidate: &str,
) -> BackendResult<bool> {
    connection
        .query_row(
            "WITH RECURSIVE descendants(id) AS (
                SELECT id FROM space_folders WHERE parent_id = ?1
                UNION ALL
                SELECT f.id FROM space_folders f JOIN descendants d ON f.parent_id = d.id
             )
             SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
            params![folder_id, candidate],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn folder_depth(connection: &Connection, folder_id: &str) -> BackendResult<i32> {
    connection
        .query_row(
            "WITH RECURSIVE ancestors(id, parent_id, depth) AS (
                SELECT id, parent_id, 1 FROM space_folders WHERE id = ?1
                UNION ALL
                SELECT f.id, f.parent_id, a.depth + 1
                FROM space_folders f JOIN ancestors a ON f.id = a.parent_id
             )
             SELECT COALESCE(MAX(depth), 0) FROM ancestors",
            [folder_id],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn folder_subtree_height(connection: &Connection, folder_id: &str) -> BackendResult<i32> {
    connection
        .query_row(
            "WITH RECURSIVE descendants(id, depth) AS (
                SELECT id, 1 FROM space_folders WHERE id = ?1
                UNION ALL
                SELECT f.id, d.depth + 1
                FROM space_folders f JOIN descendants d ON f.parent_id = d.id
             )
             SELECT COALESCE(MAX(depth), 0) FROM descendants",
            [folder_id],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn ensure_changed(changed: usize, kind: &str, id: &str) -> BackendResult<()> {
    if changed == 0 {
        Err(BackendError::NotFound(format!("{kind} {id}")))
    } else {
        Ok(())
    }
}

fn list_spaces(connection: &Connection) -> BackendResult<Vec<SpaceDto>> {
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.name, s.icon, s.root_id, r.display_path, s.folder_id,
                    s.folder_order
             FROM spaces s JOIN space_roots r ON r.id = s.root_id
             ORDER BY s.folder_order, s.created_at",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(SpaceDto {
                id: row.get(0)?,
                name: row.get(1)?,
                icon: row.get(2)?,
                root_id: row.get(3)?,
                root_path: row.get(4)?,
                folder_id: row.get(5)?,
                folder_order: row.get(6)?,
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn load_space_from_connection(
    connection: &Connection,
    space_id: &str,
) -> BackendResult<SpaceSnapshotDto> {
    let space = list_spaces(connection)?
        .into_iter()
        .find(|space| space.id == space_id)
        .ok_or_else(|| BackendError::NotFound(format!("space {space_id}")))?;
    let layout = load_layout(connection, space_id)?;
    let tabs = load_tabs(connection, space_id)?;
    let cli_sessions = load_cli_sessions(connection, space_id)?;
    Ok(SpaceSnapshotDto {
        space,
        tabs,
        layout,
        cli_sessions,
    })
}

fn load_layout(connection: &Connection, space_id: &str) -> BackendResult<SpaceLayoutDto> {
    connection
        .query_row(
            "SELECT dockview_snapshot, active_tab_id, focused_group_id, layout_revision
             FROM space_layouts WHERE space_id = ?1",
            [space_id],
            |row| {
                let snapshot: Option<String> = row.get(0)?;
                Ok(SpaceLayoutDto {
                    space_id: space_id.to_string(),
                    dockview_snapshot: snapshot.and_then(|value| serde_json::from_str(&value).ok()),
                    active_tab_id: row.get(1)?,
                    focused_group_id: row.get(2)?,
                    layout_revision: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| BackendError::NotFound(format!("layout for space {space_id}")))
}

fn load_tabs(connection: &Connection, space_id: &str) -> BackendResult<Vec<TabDto>> {
    let mut statement = connection
        .prepare(
            "SELECT id, space_id, kind, title, resource_id, state_version, state_json
             FROM tabs WHERE space_id = ?1 ORDER BY created_at",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([space_id], |row| {
            let kind: String = row.get(2)?;
            let state: String = row.get(6)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                kind,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, u32>(5)?,
                state,
            ))
        })
        .map_err(storage_error)?;
    rows.map(|row| {
        let (id, space_id, kind, title, resource_id, state_version, state) =
            row.map_err(storage_error)?;
        Ok(TabDto {
            id,
            space_id,
            kind: parse_tab_kind(&kind)?,
            title,
            resource_id,
            state_version,
            state: serde_json::from_str(&state)
                .map_err(|error| BackendError::Storage(error.to_string()))?,
        })
    })
    .collect()
}

fn load_tab(connection: &Connection, tab_id: &str) -> BackendResult<TabDto> {
    connection
        .query_row(
            "SELECT id, space_id, kind, title, resource_id, state_version, state_json
             FROM tabs WHERE id = ?1",
            [tab_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, u32>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| BackendError::NotFound(format!("tab {tab_id}")))
        .and_then(
            |(id, space_id, kind, title, resource_id, state_version, state)| {
                Ok(TabDto {
                    id,
                    space_id,
                    kind: parse_tab_kind(&kind)?,
                    title,
                    resource_id,
                    state_version,
                    state: serde_json::from_str(&state)
                        .map_err(|error| BackendError::Storage(error.to_string()))?,
                })
            },
        )
}

fn load_cli_sessions(connection: &Connection, space_id: &str) -> BackendResult<Vec<CliSessionDto>> {
    let mut statement = connection
        .prepare(
            "SELECT id, space_id, provider, cwd, native_session_id, native_binding_state,
                    desired_state, last_exit_summary
             FROM cli_sessions WHERE space_id = ?1 ORDER BY created_at",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([space_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(storage_error)?;
    rows.map(|row| row.map_err(storage_error).and_then(session_from_row))
        .collect()
}

fn list_agents(connection: &Connection) -> BackendResult<Vec<AgentSummaryDto>> {
    let mut statement = connection
        .prepare(
            "SELECT cs.id, cs.space_id, s.name, t.id, t.title, cs.provider
             FROM cli_sessions cs
             JOIN spaces s ON s.id = cs.space_id
             JOIN tabs t ON t.resource_id = cs.id AND t.kind = 'cli-session'
             WHERE cs.provider IN ('claude', 'codex')
             ORDER BY s.folder_order, s.created_at, cs.created_at",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(storage_error)?;
    rows.map(|row| {
        let (cli_session_id, space_id, space_name, tab_id, tab_title, provider) =
            row.map_err(storage_error)?;
        Ok(AgentSummaryDto {
            cli_session_id,
            space_id,
            space_name,
            tab_id,
            tab_title,
            provider: parse_provider(&provider)?,
            activity: AgentActivity::Stopped,
            runtime_id: None,
        })
    })
    .collect()
}

fn load_cli_session(connection: &Connection, session_id: &str) -> BackendResult<CliSessionDto> {
    connection
        .query_row(
            "SELECT id, space_id, provider, cwd, native_session_id, native_binding_state,
                    desired_state, last_exit_summary
             FROM cli_sessions WHERE id = ?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| BackendError::NotFound(format!("CLI session {session_id}")))
        .and_then(session_from_row)
}

type SessionRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
);

fn session_from_row(row: SessionRow) -> BackendResult<CliSessionDto> {
    Ok(CliSessionDto {
        id: row.0,
        space_id: row.1,
        provider: parse_provider(&row.2)?,
        cwd: row.3,
        native_session_id: row.4,
        native_binding_state: parse_binding_state(&row.5)?,
        desired_state: parse_desired_state(&row.6)?,
        last_exit_summary: row.7,
    })
}

fn parse_tab_kind(value: &str) -> BackendResult<TabKind> {
    match value {
        "cli-session" => Ok(TabKind::CliSession),
        "browser" => Ok(TabKind::Browser),
        "file-explorer" => Ok(TabKind::FileExplorer),
        "file-editor" => Ok(TabKind::FileEditor),
        "git" => Ok(TabKind::Git),
        _ => Err(BackendError::Storage(format!("unknown tab kind {value}"))),
    }
}

fn normalized_editor_path(value: &str) -> BackendResult<String> {
    let value = value.trim().replace('\\', "/");
    if value.is_empty()
        || value.starts_with('/')
        || value.ends_with('/')
        || value
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(BackendError::Invalid(
            "file paths must name a Space-relative file".into(),
        ));
    }
    Ok(value)
}

fn parse_provider(value: &str) -> BackendResult<ProviderKind> {
    match value {
        "shell" => Ok(ProviderKind::Shell),
        "claude" => Ok(ProviderKind::Claude),
        "codex" => Ok(ProviderKind::Codex),
        _ => Err(BackendError::Storage(format!("unknown provider {value}"))),
    }
}

fn provider_text(value: ProviderKind) -> &'static str {
    match value {
        ProviderKind::Shell => "shell",
        ProviderKind::Claude => "claude",
        ProviderKind::Codex => "codex",
    }
}

fn provider_title(value: ProviderKind) -> &'static str {
    match value {
        ProviderKind::Shell => "Shell",
        ProviderKind::Claude => "Claude Code",
        ProviderKind::Codex => "Codex",
    }
}

fn parse_binding_state(value: &str) -> BackendResult<NativeBindingState> {
    match value {
        "not_applicable" => Ok(NativeBindingState::NotApplicable),
        "pending" => Ok(NativeBindingState::Pending),
        "bound" => Ok(NativeBindingState::Bound),
        "unavailable" => Ok(NativeBindingState::Unavailable),
        _ => Err(BackendError::Storage(format!(
            "unknown native binding state {value}"
        ))),
    }
}

fn parse_desired_state(value: &str) -> BackendResult<DesiredState> {
    match value {
        "running" => Ok(DesiredState::Running),
        "stopped" => Ok(DesiredState::Stopped),
        _ => Err(BackendError::Storage(format!(
            "unknown desired state {value}"
        ))),
    }
}

fn desired_state_text(value: DesiredState) -> &'static str {
    match value {
        DesiredState::Running => "running",
        DesiredState::Stopped => "stopped",
    }
}

#[cfg(windows)]
fn persisted_path(path: &Path) -> String {
    normalize_windows_path(&path.to_string_lossy())
}

#[cfg(not(windows))]
fn persisted_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn normalize_windows_path(value: &str) -> String {
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{path}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
}

#[cfg(windows)]
fn normalize_stored_windows_paths(connection: &mut Connection) -> BackendResult<()> {
    let roots = {
        let mut statement = connection
            .prepare("SELECT id, display_path FROM space_roots")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
    };
    let sessions = {
        let mut statement = connection
            .prepare("SELECT id, cwd FROM cli_sessions")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
    };
    let transaction = connection.transaction().map_err(storage_error)?;
    for (id, path) in roots {
        let normalized = normalize_windows_path(&path);
        if normalized != path {
            transaction
                .execute(
                    "UPDATE space_roots SET display_path = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, normalized, now_timestamp()],
                )
                .map_err(storage_error)?;
        }
    }
    for (id, path) in sessions {
        let normalized = normalize_windows_path(&path);
        if normalized != path {
            transaction
                .execute(
                    "UPDATE cli_sessions SET cwd = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, normalized, now_timestamp()],
                )
                .map_err(storage_error)?;
        }
    }
    transaction.commit().map_err(storage_error)
}

#[cfg(not(windows))]
fn normalize_stored_windows_paths(_connection: &mut Connection) -> BackendResult<()> {
    Ok(())
}

fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn storage_error(error: rusqlite::Error) -> BackendError {
    BackendError::Storage(error.to_string())
}
