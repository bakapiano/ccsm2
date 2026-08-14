use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};

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
fn git_reads_tracked_and_untracked_file_diffs() {
    let directory = tempfile::tempdir().unwrap();
    git(directory.path(), &["init"]);
    std::fs::write(
        directory.path().join("tracked.rs"),
        "fn main() {\n    println!(\"old\");\n}\n",
    )
    .unwrap();
    git(directory.path(), &["add", "tracked.rs"]);
    git(
        directory.path(),
        &[
            "-c",
            "user.name=CCSM Test",
            "-c",
            "user.email=ccsm@example.test",
            "commit",
            "-m",
            "initial",
        ],
    );
    std::fs::write(
        directory.path().join("tracked.rs"),
        "fn main() {\n    println!(\"new\");\n    println!(\"added\");\n}\n",
    )
    .unwrap();
    std::fs::write(directory.path().join("new.md"), "# Added\n\ncontent").unwrap();

    let backend = CommandGitBackend::new();
    let root = descriptor(directory.path());
    let snapshot = backend.scan(&root, 8).unwrap();
    let repository = snapshot.repositories.first().unwrap();
    let tracked = repository
        .files
        .iter()
        .find(|change| change.path == "tracked.rs")
        .unwrap();
    let tracked_diff = backend.diff(&root, repository, tracked).unwrap();

    assert_eq!(tracked_diff.additions, 2);
    assert_eq!(tracked_diff.deletions, 1);
    assert!(tracked_diff.hunks.iter().any(|hunk| {
        hunk.lines
            .iter()
            .any(|line| line.content.contains("println!(\"new\")"))
    }));

    let untracked = repository
        .files
        .iter()
        .find(|change| change.path == "new.md")
        .unwrap();
    let untracked_diff = backend.diff(&root, repository, untracked).unwrap();
    assert_eq!(untracked_diff.additions, 3);
    assert_eq!(untracked_diff.deletions, 0);
    assert_eq!(untracked_diff.hunks.len(), 1);
    assert_eq!(untracked_diff.hunks[0].lines[0].content, "# Added");
    assert_eq!(
        untracked_diff.hunks[0].lines.last().unwrap().content,
        "No newline at end of file"
    );
}

#[test]
fn git_reads_a_two_way_diff_for_conflicted_working_content() {
    let directory = tempfile::tempdir().unwrap();
    git(directory.path(), &["init", "--initial-branch=main"]);
    std::fs::write(directory.path().join("conflict.txt"), "base\n").unwrap();
    git(directory.path(), &["add", "conflict.txt"]);
    commit(directory.path(), "base");

    git(directory.path(), &["checkout", "-b", "other"]);
    std::fs::write(directory.path().join("conflict.txt"), "other\n").unwrap();
    git(directory.path(), &["add", "conflict.txt"]);
    commit(directory.path(), "other");

    git(directory.path(), &["checkout", "main"]);
    std::fs::write(directory.path().join("conflict.txt"), "main\n").unwrap();
    git(directory.path(), &["add", "conflict.txt"]);
    commit(directory.path(), "main");
    let merge = Command::new("git")
        .current_dir(directory.path())
        .args(["merge", "other"])
        .status()
        .unwrap();
    assert!(!merge.success());

    let backend = CommandGitBackend::new();
    let root = descriptor(directory.path());
    let snapshot = backend.scan(&root, 9).unwrap();
    let repository = snapshot.repositories.first().unwrap();
    let change = repository
        .files
        .iter()
        .find(|change| change.path == "conflict.txt")
        .unwrap();
    assert_eq!(change.kind, "conflicted");

    let diff = backend.diff(&root, repository, change).unwrap();
    assert!(!diff.hunks.is_empty());
    assert!(diff.hunks.iter().any(|hunk| {
        hunk.lines
            .iter()
            .any(|line| line.content.contains("<<<<<<< HEAD"))
    }));
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

#[test]
fn watcher_reports_changes_from_a_materialized_nested_scope() {
    let directory = tempfile::tempdir().unwrap();
    let nested = directory.path().join("nested").join("deeper");
    std::fs::create_dir_all(&nested).unwrap();
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
    handle
        .add_scopes(&[PathBuf::from("nested/deeper")])
        .unwrap();

    std::fs::write(nested.join("watched.txt"), "changed").unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut observed = false;
    while std::time::Instant::now() < deadline {
        let Ok(event) = receiver.recv_timeout(Duration::from_millis(500)) else {
            continue;
        };
        if event
            .relative_paths
            .iter()
            .any(|path| path == "nested/deeper/watched.txt")
        {
            observed = true;
            break;
        }
    }
    assert!(observed, "watcher did not report the scoped nested file");
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
        "watcher did not report accessible.txt from the shallow root scope"
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

fn commit(cwd: &Path, message: &str) {
    git(
        cwd,
        &[
            "-c",
            "user.name=CCSM Test",
            "-c",
            "user.email=ccsm@example.test",
            "commit",
            "-m",
            message,
        ],
    );
}
