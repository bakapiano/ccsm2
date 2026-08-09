use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

use ccsm_core::{
    dto::{GitFileChangeDto, GitRepositoryStatusDto, GitSnapshotDto},
    error::{BackendError, BackendResult},
    ports::{GitBackend, RootDescriptor},
};
use uuid::Uuid;

pub struct CommandGitBackend;

impl CommandGitBackend {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CommandGitBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl GitBackend for CommandGitBackend {
    fn scan(&self, root: &RootDescriptor, scan_generation: u32) -> BackendResult<GitSnapshotDto> {
        let root_path = PathBuf::from(&root.root_path)
            .canonicalize()
            .map_err(|error| BackendError::Platform(format!("canonicalize Space root: {error}")))?;
        let mut candidates = vec![root_path.clone()];
        let children = std::fs::read_dir(&root_path)
            .map_err(|error| BackendError::Platform(format!("scan Space root: {error}")))?;
        for child in children {
            let child = child
                .map_err(|error| BackendError::Platform(format!("scan Space child: {error}")))?;
            let file_type = child
                .file_type()
                .map_err(|error| BackendError::Platform(format!("read child type: {error}")))?;
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let name = child.file_name();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            if child.path().join(".git").exists() {
                candidates.push(child.path());
            }
        }

        let mut seen = HashSet::new();
        let mut repositories = Vec::new();
        for candidate in candidates {
            let Some(repository_root) = confirmed_repository_root(&candidate)? else {
                continue;
            };
            if !repository_root.starts_with(&root_path) || !seen.insert(repository_root.clone()) {
                continue;
            }
            if candidate == root_path && repository_root != root_path {
                continue;
            }
            repositories.push(repository_status(&root_path, &repository_root));
        }
        repositories.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(GitSnapshotDto {
            space_id: root.space_id.clone(),
            root_id: root.root_id.clone(),
            scan_generation,
            repositories,
        })
    }
}

fn confirmed_repository_root(candidate: &Path) -> BackendResult<Option<PathBuf>> {
    let output = git_output(candidate, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    PathBuf::from(value)
        .canonicalize()
        .map(Some)
        .map_err(|error| BackendError::Platform(format!("canonicalize Git root: {error}")))
}

fn repository_status(space_root: &Path, repository_root: &Path) -> GitRepositoryStatusDto {
    let relative_path = repository_root
        .strip_prefix(space_root)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .map(path_to_slashes)
        .unwrap_or_else(|| ".".into());
    let root_path = repository_root.to_string_lossy().to_string();
    let repository_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, root_path.as_bytes()).to_string();
    let captured_at = now_timestamp();
    match git_output(
        repository_root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    ) {
        Ok(output) if output.status.success() => {
            let (branch, files) = parse_porcelain_v2(&output.stdout);
            GitRepositoryStatusDto {
                repository_id,
                relative_path,
                root_path,
                branch,
                files,
                captured_at,
                error: None,
            }
        }
        Ok(output) => GitRepositoryStatusDto {
            repository_id,
            relative_path,
            root_path,
            branch: None,
            files: Vec::new(),
            captured_at,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        },
        Err(error) => GitRepositoryStatusDto {
            repository_id,
            relative_path,
            root_path,
            branch: None,
            files: Vec::new(),
            captured_at,
            error: Some(error.to_string()),
        },
    }
}

fn parse_porcelain_v2(bytes: &[u8]) -> (Option<String>, Vec<GitFileChangeDto>) {
    let records = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut branch = None;
    let mut changes = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = String::from_utf8_lossy(records[index]);
        for line in record.lines() {
            if let Some(value) = line.strip_prefix("# branch.head ") {
                if value != "(detached)" {
                    branch = Some(value.to_string());
                }
                continue;
            }
            if let Some(path) = line.strip_prefix("? ") {
                changes.push(change(path, None, "?", "?", "untracked"));
                continue;
            }
            if let Some(path) = line.strip_prefix("! ") {
                let _ = path;
                continue;
            }
            if line.starts_with("1 ") {
                let fields = line.splitn(9, ' ').collect::<Vec<_>>();
                if fields.len() == 9 {
                    let xy = fields[1].as_bytes();
                    changes.push(change(
                        fields[8],
                        None,
                        status_char(xy.first().copied()),
                        status_char(xy.get(1).copied()),
                        change_kind(xy),
                    ));
                }
                continue;
            }
            if line.starts_with("2 ") {
                let fields = line.splitn(10, ' ').collect::<Vec<_>>();
                if fields.len() == 10 {
                    let xy = fields[1].as_bytes();
                    let original = records
                        .get(index + 1)
                        .map(|value| String::from_utf8_lossy(value).to_string());
                    changes.push(change(
                        fields[9],
                        original,
                        status_char(xy.first().copied()),
                        status_char(xy.get(1).copied()),
                        change_kind(xy),
                    ));
                    index += 1;
                }
                continue;
            }
            if line.starts_with("u ") {
                let fields = line.splitn(11, ' ').collect::<Vec<_>>();
                if fields.len() == 11 {
                    changes.push(change(fields[10], None, "U", "U", "conflicted"));
                }
            }
        }
        index += 1;
    }
    (branch, changes)
}

fn change(
    path: &str,
    original_path: Option<String>,
    index_status: &str,
    worktree_status: &str,
    kind: &str,
) -> GitFileChangeDto {
    GitFileChangeDto {
        path: path.to_string(),
        original_path,
        index_status: index_status.to_string(),
        worktree_status: worktree_status.to_string(),
        kind: kind.to_string(),
    }
}

fn status_char(value: Option<u8>) -> &'static str {
    match value {
        Some(b'.' | b' ') | None => "",
        Some(b'M') => "M",
        Some(b'T') => "T",
        Some(b'A') => "A",
        Some(b'D') => "D",
        Some(b'R') => "R",
        Some(b'C') => "C",
        Some(b'U') => "U",
        Some(_) => "?",
    }
}

fn change_kind(xy: &[u8]) -> &'static str {
    if xy.contains(&b'U') {
        "conflicted"
    } else if xy.contains(&b'D') {
        "deleted"
    } else if xy.contains(&b'R') {
        "renamed"
    } else if xy.contains(&b'C') {
        "copied"
    } else if xy.contains(&b'A') {
        "added"
    } else if xy.contains(&b'T') {
        "type-changed"
    } else {
        "modified"
    }
}

fn git_output(cwd: &Path, arguments: &[&str]) -> BackendResult<Output> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(arguments);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command
        .output()
        .map_err(|error| BackendError::Platform(format!("run Git: {error}")))
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

fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}
