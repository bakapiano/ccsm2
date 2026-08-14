use std::{path::Path, process::Command, sync::Arc, time::Duration};

use ccsm_core::ports::{FileSystemBackend, FileWatchBackend, GitBackend, RootDescriptor};
use ccsm_platform::{CommandGitBackend, LocalFileSystemBackend, NotifyFileWatchBackend};

#[test]
fn filesystem_lists_entries_and_rejects_parent_traversal() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("folder")).unwrap();
    std::fs::write(directory.path().join("hello.txt"), "hello").unwrap();
    let root = descriptor(directory.path());
    let filesystem = LocalFileSystemBackend::new();

    let entries = filesystem.list_directory(&root, "").unwrap();
    assert_eq!(entries[0].name, "folder");
    assert!(entries.iter().any(|entry| entry.name == "hello.txt"));
    assert!(filesystem.list_directory(&root, "..").is_err());
}

#[test]
fn git_discovers_root_and_direct_child_repositories() {
    let directory = tempfile::tempdir().unwrap();
    git(directory.path(), &["init"]);
    std::fs::write(directory.path().join("root.txt"), "root").unwrap();
    let child = directory.path().join("child");
    std::fs::create_dir(&child).unwrap();
    git(&child, &["init"]);
    std::fs::write(child.join("child.txt"), "child").unwrap();

    let snapshot = CommandGitBackend::new()
        .scan(&descriptor(directory.path()), 7)
        .unwrap();

    assert_eq!(snapshot.scan_generation, 7);
    assert_eq!(snapshot.repositories.len(), 2);
    assert!(
        snapshot
            .repositories
            .iter()
            .any(|repository| repository.relative_path == ".")
    );
    assert!(
        snapshot
            .repositories
            .iter()
            .any(|repository| repository.relative_path == "child")
    );
    assert!(
        snapshot
            .repositories
            .iter()
            .all(|repository| !repository.files.is_empty())
    );
}

#[test]
fn watcher_reports_space_relative_paths() {
    let directory = tempfile::tempdir().unwrap();
    let root = descriptor(directory.path());
    let (sender, receiver) = std::sync::mpsc::channel();
    let _handle = NotifyFileWatchBackend::new()
        .watch(
            &root,
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .unwrap();

    std::fs::write(directory.path().join("watched.txt"), "changed").unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut observed = false;
    while std::time::Instant::now() < deadline {
        let Ok(event) = receiver.recv_timeout(Duration::from_millis(500)) else {
            continue;
        };
        if event
            .relative_paths
            .iter()
            .any(|path| path == "watched.txt")
        {
            observed = true;
            break;
        }
    }
    assert!(observed, "watcher did not report watched.txt");
}

#[cfg(unix)]
#[test]
fn watcher_keeps_accessible_files_live_with_an_inaccessible_descendant() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let blocked = directory.path().join("blocked");
    std::fs::create_dir(&blocked).unwrap();
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let root = descriptor(directory.path());
    let (sender, receiver) = std::sync::mpsc::channel();
    let handle = NotifyFileWatchBackend::new()
        .watch(
            &root,
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .unwrap();

    std::fs::write(directory.path().join("accessible.txt"), "changed").unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut observed = false;
    while std::time::Instant::now() < deadline {
        let Ok(event) = receiver.recv_timeout(Duration::from_millis(500)) else {
            continue;
        };
        if event
            .relative_paths
            .iter()
            .any(|path| path == "accessible.txt")
        {
            observed = true;
            break;
        }
    }

    drop(handle);
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        observed,
        "watcher did not report accessible.txt after its recursive fallback"
    );
}

fn descriptor(path: &Path) -> RootDescriptor {
    RootDescriptor {
        space_id: "space".into(),
        root_id: "root".into(),
        root_path: path.to_string_lossy().into_owned(),
    }
}

fn git(cwd: &Path, arguments: &[&str]) {
    let status = Command::new("git")
        .current_dir(cwd)
        .args(arguments)
        .status()
        .unwrap();
    assert!(status.success());
}
