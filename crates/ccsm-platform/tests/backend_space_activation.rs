use std::{path::PathBuf, sync::Arc};

use ccsm_core::{
    AppBackend,
    dto::{CreateSpaceRequest, ListDirectoryRequest},
    error::{BackendError, BackendResult},
    ports::{
        FileWatchBackend, FileWatchEventSink, FileWatchHandle, PtyBackend, PtyEventSink,
        PtyProcess, PtySpawnSpec, RootDescriptor, StateStore,
    },
};
use ccsm_platform::{CommandGitBackend, LocalFileSystemBackend, SqliteStateStore};

struct NoopWatchHandle;

impl FileWatchHandle for NoopWatchHandle {}

struct RejectRootWatcher {
    rejected_root: PathBuf,
}

impl FileWatchBackend for RejectRootWatcher {
    fn watch(
        &self,
        root: &RootDescriptor,
        _sink: FileWatchEventSink,
    ) -> BackendResult<Box<dyn FileWatchHandle>> {
        if PathBuf::from(&root.root_path) == self.rejected_root {
            return Err(BackendError::Platform("forced watch failure".into()));
        }
        Ok(Box::new(NoopWatchHandle))
    }
}

struct UnusedPtyBackend;

impl PtyBackend for UnusedPtyBackend {
    fn spawn(
        &self,
        _spec: PtySpawnSpec,
        _event_sink: PtyEventSink,
    ) -> BackendResult<Arc<dyn PtyProcess>> {
        Err(BackendError::Platform(
            "PTY spawn is outside this test".into(),
        ))
    }
}

#[test]
fn create_space_removes_the_partial_graph_when_root_activation_fails() {
    let database_directory = tempfile::tempdir().unwrap();
    let initial_root = tempfile::tempdir().unwrap();
    let rejected_root = tempfile::tempdir().unwrap();
    let store =
        Arc::new(SqliteStateStore::open(&database_directory.path().join("data.db")).unwrap());
    let backend = backend(Arc::clone(&store), rejected_root.path().to_path_buf());
    let initial = backend.bootstrap(initial_root.path()).unwrap();

    let error = backend
        .create_space(CreateSpaceRequest {
            name: "Rejected".into(),
            root_path: rejected_root.path().to_string_lossy().into_owned(),
            folder_id: None,
        })
        .unwrap_err();

    assert!(error.to_string().contains("forced watch failure"));
    let persisted = store.workspace_state().unwrap();
    assert_eq!(persisted.active_space_id, initial.active_space_id);
    assert_eq!(persisted.spaces.len(), 1);
    backend
        .list_directory(ListDirectoryRequest {
            space_id: initial.active_space_id,
            relative_path: String::new(),
        })
        .unwrap();
}

#[test]
fn switch_space_restores_the_previous_active_space_when_root_activation_fails() {
    let database_directory = tempfile::tempdir().unwrap();
    let initial_root = tempfile::tempdir().unwrap();
    let rejected_root = tempfile::tempdir().unwrap();
    let store =
        Arc::new(SqliteStateStore::open(&database_directory.path().join("data.db")).unwrap());
    let backend = backend(Arc::clone(&store), rejected_root.path().to_path_buf());
    let initial = backend.bootstrap(initial_root.path()).unwrap();
    let created = store
        .create_space(CreateSpaceRequest {
            name: "Rejected".into(),
            root_path: rejected_root.path().to_string_lossy().into_owned(),
            folder_id: None,
        })
        .unwrap();
    let rejected_space_id = created.active_space_id;
    store.switch_space(&initial.active_space_id).unwrap();

    let error = backend.switch_space(&rejected_space_id).unwrap_err();

    assert!(error.to_string().contains("forced watch failure"));
    let persisted = store.workspace_state().unwrap();
    assert_eq!(persisted.active_space_id, initial.active_space_id);
    assert_eq!(persisted.spaces.len(), 2);
    backend
        .list_directory(ListDirectoryRequest {
            space_id: initial.active_space_id,
            relative_path: String::new(),
        })
        .unwrap();
}

fn backend(store: Arc<SqliteStateStore>, rejected_root: PathBuf) -> Arc<AppBackend> {
    AppBackend::new(
        store,
        Arc::new(UnusedPtyBackend),
        Arc::new(LocalFileSystemBackend::new()),
        Arc::new(CommandGitBackend::new()),
        Arc::new(RejectRootWatcher { rejected_root }),
        Arc::new(|_| {}),
    )
}
