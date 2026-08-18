use std::sync::Arc;

use ccsm_core::{
    dto::{
        CreateBrowserTabRequest, CreateCliTabRequest, CreateFileEditorTabRequest,
        CreateFileExplorerTabRequest, CreateFolderRequest, CreateGitTabRequest, CreateSpaceRequest,
        DeleteFolderRequest, DeleteSpaceRequest, DeleteTabRequest, MoveSpaceRequest,
        NativeBindingState, ProviderKind, RenameFolderRequest, RenameSpaceRequest,
        SaveLayoutRequest, SetFolderCollapsedRequest,
    },
    ports::StateStore,
};
use ccsm_platform::SqliteStateStore;
use serde_json::json;

#[test]
fn bootstrap_persists_default_shell_files_and_changes() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("data.db");
    let store = Arc::new(SqliteStateStore::open(&database).unwrap());

    let first = store.bootstrap(directory.path()).unwrap();
    let second = store.bootstrap(directory.path()).unwrap();

    assert_eq!(first.spaces.len(), 1);
    assert_eq!(first.active_space_id, second.active_space_id);
    assert_eq!(first.active_snapshot.tabs.len(), 3);
    assert!(
        first
            .active_snapshot
            .tabs
            .iter()
            .any(|tab| tab.kind == ccsm_core::dto::TabKind::CliSession)
    );
    assert!(
        first
            .active_snapshot
            .tabs
            .iter()
            .any(|tab| tab.kind == ccsm_core::dto::TabKind::FileExplorer)
    );
    assert!(
        first
            .active_snapshot
            .tabs
            .iter()
            .any(|tab| tab.kind == ccsm_core::dto::TabKind::Git)
    );
    assert_eq!(first.active_snapshot.cli_sessions.len(), 1);
}

#[test]
fn space_and_folder_names_cannot_exceed_64_characters() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    let state = store.bootstrap(directory.path()).unwrap();
    let too_long = "名".repeat(65);

    let space_error = store
        .rename_space(RenameSpaceRequest {
            space_id: state.active_space_id,
            name: too_long.clone(),
        })
        .unwrap_err();
    assert!(
        space_error
            .to_string()
            .contains("cannot exceed 64 characters")
    );

    let folder_error = store
        .create_folder(CreateFolderRequest {
            parent_id: None,
            name: too_long,
        })
        .unwrap_err();
    assert!(
        folder_error
            .to_string()
            .contains("cannot exceed 64 characters")
    );
}

#[test]
fn deleting_cli_tab_removes_its_agent_and_session() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    let state = store.bootstrap(directory.path()).unwrap();
    let created = store
        .create_cli_tab(CreateCliTabRequest {
            space_id: state.active_space_id.clone(),
            provider: ProviderKind::Codex,
        })
        .unwrap();
    assert_eq!(store.list_agents().unwrap().len(), 1);

    let deleted = store
        .delete_tab(DeleteTabRequest {
            space_id: state.active_space_id.clone(),
            tab_id: created.tab.id.clone(),
        })
        .unwrap();

    assert_eq!(deleted.id, created.tab.id);
    assert!(store.list_agents().unwrap().is_empty());
    assert!(store.get_cli_session(&created.cli_session.id).is_err());
    assert!(
        store
            .load_space(&state.active_space_id)
            .unwrap()
            .tabs
            .iter()
            .all(|tab| tab.id != created.tab.id)
    );
}

#[test]
fn deleted_git_tab_stays_deleted_and_can_be_created_again() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("data.db");
    let space_id = {
        let store = SqliteStateStore::open(&database).unwrap();
        let state = store.bootstrap(directory.path()).unwrap();
        let git = state
            .active_snapshot
            .tabs
            .iter()
            .find(|tab| tab.kind == ccsm_core::dto::TabKind::Git)
            .unwrap();
        store
            .delete_tab(DeleteTabRequest {
                space_id: state.active_space_id.clone(),
                tab_id: git.id.clone(),
            })
            .unwrap();
        state.active_space_id
    };

    let store = SqliteStateStore::open(&database).unwrap();
    let reopened = store.bootstrap(directory.path()).unwrap();
    assert!(
        reopened
            .active_snapshot
            .tabs
            .iter()
            .all(|tab| tab.kind != ccsm_core::dto::TabKind::Git)
    );
    let recreated = store
        .create_git_tab(CreateGitTabRequest {
            space_id: space_id.clone(),
        })
        .unwrap();
    assert_eq!(recreated.kind, ccsm_core::dto::TabKind::Git);
    assert_eq!(recreated.space_id, space_id);
    assert_eq!(recreated.title, "Changes");
}

#[test]
fn legacy_git_tab_title_migrates_to_changes() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("data.db");
    {
        let store = SqliteStateStore::open(&database).unwrap();
        store.bootstrap(directory.path()).unwrap();
    }
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute("UPDATE tabs SET title = 'Git' WHERE kind = 'git'", [])
        .unwrap();

    let store = SqliteStateStore::open(&database).unwrap();
    let reopened = store.bootstrap(directory.path()).unwrap();
    let changes = reopened
        .active_snapshot
        .tabs
        .iter()
        .find(|tab| tab.kind == ccsm_core::dto::TabKind::Git)
        .unwrap();
    assert_eq!(changes.title, "Changes");
}

#[test]
fn stale_layout_write_does_not_replace_newer_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    let bootstrap = store.bootstrap(directory.path()).unwrap();
    let space_id = bootstrap.active_space_id;

    let latest = store
        .save_layout(SaveLayoutRequest {
            space_id: space_id.clone(),
            dockview_snapshot: json!({ "version": "new" }),
            active_tab_id: None,
            focused_group_id: None,
            layout_revision: 2,
        })
        .unwrap();
    let stale = store
        .save_layout(SaveLayoutRequest {
            space_id,
            dockview_snapshot: json!({ "version": "old" }),
            active_tab_id: None,
            focused_group_id: None,
            layout_revision: 1,
        })
        .unwrap();

    assert_eq!(latest.layout_revision, 2);
    assert_eq!(stale.layout_revision, 2);
    assert_eq!(stale.dockview_snapshot, Some(json!({ "version": "new" })));
}

#[test]
fn folder_mutations_return_a_committed_tree() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    store.bootstrap(directory.path()).unwrap();

    let state = store
        .create_folder(CreateFolderRequest {
            parent_id: None,
            name: "Work".into(),
        })
        .unwrap();
    let work = state
        .folders
        .iter()
        .find(|folder| folder.name == "Work")
        .unwrap();
    let state = store
        .create_folder(CreateFolderRequest {
            parent_id: Some(work.id.clone()),
            name: "Client".into(),
        })
        .unwrap();
    let client = state
        .folders
        .iter()
        .find(|folder| folder.name == "Client")
        .unwrap();
    let state = store
        .create_space(CreateSpaceRequest {
            name: "Second".into(),
            root_path: directory.path().to_string_lossy().into_owned(),
            folder_id: Some(client.id.clone()),
        })
        .unwrap();
    let second = state
        .spaces
        .iter()
        .find(|space| space.name == "Second")
        .unwrap();
    assert_eq!(second.folder_id.as_deref(), Some(client.id.as_str()));

    let state = store
        .set_folder_collapsed(SetFolderCollapsedRequest {
            folder_id: work.id.clone(),
            collapsed: true,
        })
        .unwrap();
    assert!(
        state
            .folders
            .iter()
            .find(|folder| folder.id == work.id)
            .unwrap()
            .collapsed
    );

    let state = store
        .rename_folder(RenameFolderRequest {
            folder_id: work.id.clone(),
            name: "Projects".into(),
        })
        .unwrap();
    assert!(state.folders.iter().any(|folder| folder.name == "Projects"));

    let state = store
        .delete_folder(DeleteFolderRequest {
            folder_id: client.id.clone(),
        })
        .unwrap();
    let promoted = state
        .spaces
        .iter()
        .find(|space| space.id == second.id)
        .unwrap();
    assert_eq!(promoted.folder_id.as_deref(), Some(work.id.as_str()));

    let state = store
        .move_space(MoveSpaceRequest {
            space_id: second.id.clone(),
            folder_id: None,
            order: 0,
        })
        .unwrap();
    assert_eq!(
        state
            .spaces
            .iter()
            .find(|space| space.id == second.id)
            .unwrap()
            .folder_id,
        None
    );
}

#[test]
fn delete_keeps_an_active_space() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    let initial = store.bootstrap(directory.path()).unwrap();
    let first_id = initial.active_space_id;
    let created = store
        .create_space(CreateSpaceRequest {
            name: "Disposable".into(),
            root_path: directory.path().to_string_lossy().into_owned(),
            folder_id: None,
        })
        .unwrap();
    let second_id = created.active_space_id;

    let deleted = store
        .delete_space(DeleteSpaceRequest {
            space_id: second_id,
        })
        .unwrap();
    assert_eq!(deleted.spaces.len(), 1);
    assert!(
        store
            .delete_space(DeleteSpaceRequest { space_id: first_id })
            .is_err()
    );
}

#[test]
fn legacy_archived_spaces_are_restored_when_data_db_opens() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("data.db");
    let space_id = {
        let store = SqliteStateStore::open(&database).unwrap();
        store.bootstrap(directory.path()).unwrap().active_space_id
    };
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute(
            "UPDATE spaces SET archived_at = 123 WHERE id = ?1",
            [&space_id],
        )
        .unwrap();
    drop(connection);

    let store = SqliteStateStore::open(&database).unwrap();
    let state = store.bootstrap(directory.path()).unwrap();
    assert!(state.spaces.iter().any(|space| space.id == space_id));
    let connection = rusqlite::Connection::open(&database).unwrap();
    let archived_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM spaces WHERE archived_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived_count, 0);
}

#[test]
fn hook_binding_is_unique_and_persists() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("data.db");
    let (first_session_id, second_session_id) = {
        let store = SqliteStateStore::open(&database).unwrap();
        let state = store.bootstrap(directory.path()).unwrap();
        let first = store
            .create_cli_tab(CreateCliTabRequest {
                space_id: state.active_space_id.clone(),
                provider: ProviderKind::Codex,
            })
            .unwrap();
        let second = store
            .create_cli_tab(CreateCliTabRequest {
                space_id: state.active_space_id,
                provider: ProviderKind::Codex,
            })
            .unwrap();
        assert_eq!(
            first.cli_session.native_binding_state,
            NativeBindingState::Pending
        );
        let bound = store
            .bind_native_session(&first.cli_session.id, ProviderKind::Codex, "native-1")
            .unwrap();
        assert_eq!(bound.native_binding_state, NativeBindingState::Bound);
        assert!(
            store
                .bind_native_session(&second.cli_session.id, ProviderKind::Codex, "native-1")
                .is_err()
        );
        (first.cli_session.id, second.cli_session.id)
    };

    let reopened = SqliteStateStore::open(&database).unwrap();
    assert_eq!(
        reopened
            .get_cli_session(&first_session_id)
            .unwrap()
            .native_binding_state,
        NativeBindingState::Bound
    );
    assert_eq!(
        reopened
            .get_cli_session(&second_session_id)
            .unwrap()
            .native_binding_state,
        NativeBindingState::Unavailable
    );
}

#[test]
fn agents_list_resolves_every_cli_session_to_its_space_and_tab() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    let initial = store.bootstrap(directory.path()).unwrap();
    let claude = store
        .create_cli_tab(CreateCliTabRequest {
            space_id: initial.active_space_id,
            provider: ProviderKind::Claude,
        })
        .unwrap();
    let second = store
        .create_space(CreateSpaceRequest {
            name: "Second".into(),
            root_path: directory.path().to_string_lossy().into_owned(),
            folder_id: None,
        })
        .unwrap();
    let codex = store
        .create_cli_tab(CreateCliTabRequest {
            space_id: second.active_space_id.clone(),
            provider: ProviderKind::Codex,
        })
        .unwrap();
    let copilot = store
        .create_cli_tab(CreateCliTabRequest {
            space_id: second.active_space_id,
            provider: ProviderKind::Copilot,
        })
        .unwrap();

    let agents = store.list_agents().unwrap();
    assert_eq!(agents.len(), 3);
    assert!(agents.iter().any(|agent| {
        agent.cli_session_id == claude.cli_session.id
            && agent.tab_id == claude.tab.id
            && agent.provider == ProviderKind::Claude
    }));
    assert!(agents.iter().any(|agent| {
        agent.cli_session_id == codex.cli_session.id
            && agent.tab_id == codex.tab.id
            && agent.space_name == "Second"
            && agent.provider == ProviderKind::Codex
    }));
    assert!(agents.iter().any(|agent| {
        agent.cli_session_id == copilot.cli_session.id
            && agent.tab_id == copilot.tab.id
            && agent.space_name == "Second"
            && agent.provider == ProviderKind::Copilot
    }));
}

#[test]
fn browser_popup_tab_is_committed_with_its_url() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    let state = store.bootstrap(directory.path()).unwrap();
    let tab = store
        .create_browser_tab(CreateBrowserTabRequest {
            space_id: state.active_space_id.clone(),
            url: "https://example.com/popup".into(),
        })
        .unwrap();

    assert_eq!(tab.kind, ccsm_core::dto::TabKind::Browser);
    assert_eq!(tab.state["lastUrl"], "https://example.com/popup");
    assert!(
        store
            .load_space(&state.active_space_id)
            .unwrap()
            .tabs
            .iter()
            .any(|candidate| candidate.id == tab.id)
    );
}

#[test]
fn new_file_explorer_tab_is_persisted_with_default_state() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    let state = store.bootstrap(directory.path()).unwrap();
    let tab = store
        .create_file_explorer_tab(CreateFileExplorerTabRequest {
            space_id: state.active_space_id.clone(),
        })
        .unwrap();

    assert_eq!(tab.kind, ccsm_core::dto::TabKind::FileExplorer);
    assert_eq!(tab.state["expandedPaths"], serde_json::json!([]));
    assert!(
        store
            .load_space(&state.active_space_id)
            .unwrap()
            .tabs
            .iter()
            .any(|candidate| candidate.id == tab.id)
    );
}

#[test]
fn file_editor_tab_is_unique_per_space_relative_path() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStateStore::open(&directory.path().join("data.db")).unwrap();
    let state = store.bootstrap(directory.path()).unwrap();
    let request = CreateFileEditorTabRequest {
        space_id: state.active_space_id.clone(),
        relative_path: "src\\main.rs".into(),
    };

    let first = store.create_file_editor_tab(request.clone()).unwrap();
    let second = store.create_file_editor_tab(request).unwrap();

    assert_eq!(first.id, second.id);
    assert_eq!(first.kind, ccsm_core::dto::TabKind::FileEditor);
    assert_eq!(first.resource_id.as_deref(), Some("src/main.rs"));
    assert_eq!(first.state["wordWrap"], false);
    assert_eq!(
        store
            .load_space(&state.active_space_id)
            .unwrap()
            .tabs
            .iter()
            .filter(|tab| tab.kind == ccsm_core::dto::TabKind::FileEditor)
            .count(),
        1
    );
}
