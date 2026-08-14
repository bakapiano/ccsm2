use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use ccsm_core::{
    error::{BackendError, BackendResult},
    ports::{
        FileWatchBackend, FileWatchEvent, FileWatchEventSink, FileWatchHandle, RootDescriptor,
    },
};
use notify::{
    Config, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher, event::ModifyKind,
};

const POLLING_FALLBACK_INTERVAL: Duration = Duration::from_secs(2);

pub struct NotifyFileWatchBackend {
    ignored_paths: Vec<PathBuf>,
}

impl NotifyFileWatchBackend {
    pub fn new() -> Self {
        Self {
            ignored_paths: Vec::new(),
        }
    }

    pub fn with_ignored_paths(mut self, paths: impl IntoIterator<Item = PathBuf>) -> Self {
        self.ignored_paths.extend(paths);
        self
    }
}

impl Default for NotifyFileWatchBackend {
    fn default() -> Self {
        Self::new()
    }
}

struct NotifyWatchHandle {
    _native_watcher: Option<RecommendedWatcher>,
    _polling_watcher: Option<PollWatcher>,
}

impl FileWatchHandle for NotifyWatchHandle {}

impl FileWatchBackend for NotifyFileWatchBackend {
    fn watch(
        &self,
        root: &RootDescriptor,
        sink: FileWatchEventSink,
    ) -> BackendResult<Box<dyn FileWatchHandle>> {
        let root_path = std::path::PathBuf::from(&root.root_path)
            .canonicalize()
            .map_err(|error| BackendError::Platform(format!("canonicalize watch root: {error}")))?;
        let ignored_paths = self
            .ignored_paths
            .iter()
            .filter_map(|path| path.canonicalize().ok())
            .filter(|path| path != &root_path && path.starts_with(&root_path))
            .collect::<Vec<_>>();
        let mut native_watcher = RecommendedWatcher::new(
            watch_event_handler(root_path.clone(), ignored_paths.clone(), Arc::clone(&sink)),
            Config::default(),
        )
        .map_err(|error| BackendError::Platform(format!("create filesystem watcher: {error}")))?;
        match native_watcher.watch(&root_path, RecursiveMode::Recursive) {
            Ok(()) => Ok(Box::new(NotifyWatchHandle {
                _native_watcher: Some(native_watcher),
                _polling_watcher: None,
            })),
            Err(native_error) => {
                drop(native_watcher);
                let config = Config::default().with_poll_interval(POLLING_FALLBACK_INTERVAL);
                let mut polling_watcher = PollWatcher::new(
                    watch_event_handler(root_path.clone(), ignored_paths, sink),
                    config,
                )
                .map_err(|error| {
                    BackendError::Platform(format!(
                        "watch Space root: {native_error}; create polling fallback: {error}"
                    ))
                })?;
                polling_watcher
                    .watch(&root_path, RecursiveMode::Recursive)
                    .map_err(|error| {
                        BackendError::Platform(format!(
                            "watch Space root: {native_error}; polling fallback: {error}"
                        ))
                    })?;
                Ok(Box::new(NotifyWatchHandle {
                    _native_watcher: None,
                    _polling_watcher: Some(polling_watcher),
                }))
            }
        }
    }
}

fn watch_event_handler(
    callback_root: PathBuf,
    ignored_paths: Vec<PathBuf>,
    sink: FileWatchEventSink,
) -> impl FnMut(notify::Result<notify::Event>) + Send + 'static {
    move |result| match result {
        Ok(event) => {
            let relative_paths = event
                .paths
                .iter()
                .filter(|path| {
                    !ignored_paths
                        .iter()
                        .any(|ignored| path.starts_with(ignored))
                })
                .filter(|path| !is_redundant_directory_modify(event.kind, path))
                .filter_map(|path| path.strip_prefix(&callback_root).ok())
                .map(path_to_slashes)
                .filter(|path| !is_transient_git_scan_path(path))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            if relative_paths.is_empty() {
                return;
            }
            sink(FileWatchEvent {
                relative_paths,
                overflow: false,
            });
        }
        Err(_) => sink(FileWatchEvent {
            relative_paths: Vec::new(),
            overflow: true,
        }),
    }
}

fn path_to_slashes(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_transient_git_scan_path(path: &str) -> bool {
    path == ".git"
        || path.ends_with("/.git")
        || path == ".git/index.lock"
        || path.ends_with("/.git/index.lock")
}

fn is_redundant_directory_modify(kind: EventKind, path: &Path) -> bool {
    matches!(kind, EventKind::Modify(modify) if !matches!(modify, ModifyKind::Name(_)))
        && path.is_dir()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use notify::{
        EventKind,
        event::{DataChange, ModifyKind, RenameMode},
    };

    use super::{is_redundant_directory_modify, is_transient_git_scan_path};

    #[test]
    fn filters_git_status_lock_churn_without_hiding_meaningful_changes() {
        assert!(is_transient_git_scan_path(".git"));
        assert!(is_transient_git_scan_path(".git/index.lock"));
        assert!(is_transient_git_scan_path("nested/.git"));
        assert!(is_transient_git_scan_path("nested/.git/index.lock"));
        assert!(!is_transient_git_scan_path(".git/HEAD"));
        assert!(!is_transient_git_scan_path(".git/index"));
        assert!(!is_transient_git_scan_path("src/main.rs"));
    }

    #[test]
    fn filters_parent_directory_modify_noise_but_keeps_directory_renames() {
        let directory = tempfile::tempdir().unwrap();
        assert!(is_redundant_directory_modify(
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            directory.path(),
        ));
        assert!(!is_redundant_directory_modify(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            directory.path(),
        ));
        assert!(!is_redundant_directory_modify(
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            Path::new("missing-file"),
        ));
    }
}
