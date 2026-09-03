use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use ccsm_core::{
    AppBackend,
    dto::{
        BoardDocumentDto, BoardSummaryDto, CreateSpaceRequest, ListDirectoryRequest,
        ReadFileRequest,
    },
    error::{BackendError, BackendResult},
    ports::{
        BoardStore, FileWatchBackend, FileWatchEventSink, FileWatchHandle, PtyBackend,
        PtyEventSink, PtyProcess, PtySpawnSpec, RootDescriptor, StateStore,
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
        let requested_root = PathBuf::from(&root.root_path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&root.root_path));
        let rejected_root = self
            .rejected_root
            .canonicalize()
            .unwrap_or_else(|_| self.rejected_root.clone());
        if requested_root == rejected_root {
            return Err(BackendError::Platform("forced watch failure".into()));
        }
        Ok(Box::new(NoopWatchHandle))
    }
}

struct RecordingWatchHandle {
    scopes: Arc<Mutex<Vec<PathBuf>>>,
}

impl FileWatchHandle for RecordingWatchHandle {
    fn add_scopes(&self, relative_paths: &[PathBuf]) -> BackendResult<()> {
        self.scopes
            .lock()
            .unwrap()
            .extend_from_slice(relative_paths);
        Ok(())
    }
}

struct RecordingWatcher {
    scopes: Arc<Mutex<Vec<PathBuf>>>,
}

impl FileWatchBackend for RecordingWatcher {
    fn watch(
        &self,
        _root: &RootDescriptor,
        _sink: FileWatchEventSink,
    ) -> BackendResult<Box<dyn FileWatchHandle>> {
        Ok(Box::new(RecordingWatchHandle {
            scopes: Arc::clone(&self.scopes),
        }))
    }
}

struct UnusedPtyBackend;

struct UnusedBoardStore;

impl BoardStore for UnusedBoardStore {
    fn list(&self, _space_id: &str) -> BackendResult<Vec<BoardSummaryDto>> {
        Ok(Vec::new())
    }

    fn read(&self, _space_id: &str, _board_id: &str) -> BackendResult<BoardDocumentDto> {
        Err(BackendError::NotFound("Board".into()))
    }

    fn put(
        &self,
        _space_id: &str,
        _board_id: Option<&str>,
        _html: &str,
        _expected_revision: Option<&str>,
    ) -> BackendResult<BoardDocumentDto> {
        Err(BackendError::Platform(
            "Board write is outside this test".into(),
        ))
    }
}

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
            operation_id: "rollback-create".into(),
            offset: 0,
            limit: 200,
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
            operation_id: "rollback-switch".into(),
            offset: 0,
            limit: 200,
        })
        .unwrap();
}

#[test]
fn active_directory_and_file_reads_materialize_watch_scopes() {
    let database_directory = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let nested = root.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join("file.txt"), "content").unwrap();
    let store =
        Arc::new(SqliteStateStore::open(&database_directory.path().join("data.db")).unwrap());
    let scopes = Arc::new(Mutex::new(Vec::new()));
    let backend = AppBackend::new(
        store.clone(),
        Arc::new(UnusedPtyBackend),
        Arc::new(UnusedBoardStore),
        Arc::new(LocalFileSystemBackend::new()),
        Arc::new(CommandGitBackend::new()),
        Arc::new(RecordingWatcher {
            scopes: Arc::clone(&scopes),
        }),
        Arc::new(|_| {}),
    );
    let initial = backend.bootstrap(root.path()).unwrap();

    backend
        .list_directory(ListDirectoryRequest {
            space_id: initial.active_space_id.clone(),
            relative_path: "nested".into(),
            operation_id: "watch-scope".into(),
            offset: 0,
            limit: 200,
        })
        .unwrap();
    backend
        .read_file(ReadFileRequest {
            space_id: initial.active_space_id,
            relative_path: "nested/file.txt".into(),
        })
        .unwrap();

    let scopes = scopes.lock().unwrap();
    assert!(scopes.iter().any(|scope| scope == &PathBuf::from("nested")));
}

fn backend(store: Arc<SqliteStateStore>, rejected_root: PathBuf) -> Arc<AppBackend> {
    AppBackend::new(
        store,
        Arc::new(UnusedPtyBackend),
        Arc::new(UnusedBoardStore),
        Arc::new(LocalFileSystemBackend::new()),
        Arc::new(CommandGitBackend::new()),
        Arc::new(RejectRootWatcher { rejected_root }),
        Arc::new(|_| {}),
    )
}
