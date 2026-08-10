use std::sync::{Arc, Mutex};

use crate::{
    dto::{
        AppEvent, DirectoryListingDto, FileChangeHintDto, FileDocumentDto, GitSnapshotDto,
        ListDirectoryRequest, ReadFileRequest, RefreshGitRequest, WriteFileRequest,
        WriteFileResultDto,
    },
    error::{BackendError, BackendResult},
    ports::{
        FileSystemBackend, FileWatchBackend, FileWatchEventSink, FileWatchHandle, GitBackend,
        RootDescriptor, StateStore,
    },
};

pub type AppEventSink = Arc<dyn Fn(AppEvent) + Send + Sync + 'static>;

#[derive(Default)]
struct ActiveRootState {
    root: Option<RootDescriptor>,
    scan_generation: u32,
    watcher: Option<Box<dyn FileWatchHandle>>,
}

pub struct ActiveRootContext {
    store: Arc<dyn StateStore>,
    filesystem: Arc<dyn FileSystemBackend>,
    git: Arc<dyn GitBackend>,
    file_watch: Arc<dyn FileWatchBackend>,
    event_sink: AppEventSink,
    state: Mutex<ActiveRootState>,
}

impl ActiveRootContext {
    pub fn new(
        store: Arc<dyn StateStore>,
        filesystem: Arc<dyn FileSystemBackend>,
        git: Arc<dyn GitBackend>,
        file_watch: Arc<dyn FileWatchBackend>,
        event_sink: AppEventSink,
    ) -> Self {
        Self {
            store,
            filesystem,
            git,
            file_watch,
            event_sink,
            state: Mutex::new(ActiveRootState::default()),
        }
    }

    pub fn activate(&self, space_id: &str) -> BackendResult<()> {
        let root = self.store.space_root(space_id)?;
        {
            let mut state = self.lock_state()?;
            if state
                .root
                .as_ref()
                .is_some_and(|active| active.root_id == root.root_id)
            {
                state.root = Some(root);
                return Ok(());
            }
        }
        let root_id = root.root_id.clone();
        let event_sink = Arc::clone(&self.event_sink);
        let watcher_sink: FileWatchEventSink = Arc::new(move |event| {
            event_sink(AppEvent::FilesystemChanged {
                payload: FileChangeHintDto {
                    root_id: root_id.clone(),
                    relative_paths: event.relative_paths,
                    overflow: event.overflow,
                },
            });
        });
        let watcher = self.file_watch.watch(&root, watcher_sink)?;
        let mut state = self.lock_state()?;
        state.root = Some(root);
        state.scan_generation = 0;
        state.watcher = Some(watcher);
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.watcher = None;
            state.root = None;
        }
    }

    pub fn list_directory(
        &self,
        request: ListDirectoryRequest,
    ) -> BackendResult<DirectoryListingDto> {
        let root = self.active_root(&request.space_id)?;
        let entries = self
            .filesystem
            .list_directory(&root, &request.relative_path)?;
        Ok(DirectoryListingDto {
            space_id: request.space_id,
            relative_path: request.relative_path,
            entries,
        })
    }

    pub fn read_file(&self, request: ReadFileRequest) -> BackendResult<FileDocumentDto> {
        let root = self.store.space_root(&request.space_id)?;
        self.filesystem.read_file(&root, &request.relative_path)
    }

    pub fn write_file(&self, request: WriteFileRequest) -> BackendResult<WriteFileResultDto> {
        let root = self.store.space_root(&request.space_id)?;
        self.filesystem.write_file(&root, &request)
    }

    pub fn cached_git(&self, space_id: &str) -> BackendResult<GitSnapshotDto> {
        let root = self.active_root(space_id)?;
        self.store.load_git_cache(space_id, &root.root_id)
    }

    pub fn refresh_git(&self, request: RefreshGitRequest) -> BackendResult<GitSnapshotDto> {
        let (root, generation) = {
            let mut state = self.lock_state()?;
            let root = state
                .root
                .clone()
                .filter(|root| root.space_id == request.space_id)
                .ok_or_else(|| {
                    BackendError::Conflict(format!(
                        "Space {} is not the active root context",
                        request.space_id
                    ))
                })?;
            state.scan_generation = state.scan_generation.wrapping_add(1).max(1);
            (root, state.scan_generation)
        };
        let snapshot = self.git.scan(&root, generation)?;
        self.store.save_git_cache(&snapshot)?;
        Ok(snapshot)
    }

    fn active_root(&self, space_id: &str) -> BackendResult<RootDescriptor> {
        self.lock_state()?
            .root
            .clone()
            .filter(|root| root.space_id == space_id)
            .ok_or_else(|| {
                BackendError::Conflict(format!("Space {space_id} is not the active root context"))
            })
    }

    fn lock_state(&self) -> BackendResult<std::sync::MutexGuard<'_, ActiveRootState>> {
        self.state
            .lock()
            .map_err(|_| BackendError::Platform("active root context lock poisoned".into()))
    }
}
