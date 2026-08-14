use std::{
    collections::HashSet,
    ffi::OsStr,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use ccsm_core::{
    dto::{
        GitDiffHunkDto, GitDiffLineDto, GitDiffLineKind, GitFileChangeDto, GitFileDiffDto,
        GitRepositoryStatusDto, GitSnapshotDto,
    },
    error::{BackendError, BackendResult},
    ports::{GitBackend, RootDescriptor},
};
use uuid::Uuid;

use crate::containment::ProcessContainment;

const GIT_SCAN_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_STREAM_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const GIT_WAIT_INTERVAL: Duration = Duration::from_millis(10);
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_RENDERED_DIFF_BYTES: usize = 4 * 1024 * 1024;

pub struct CommandGitBackend {
    cancellation_generation: Arc<AtomicU64>,
    active_root: Mutex<ActiveGitRoot>,
}

enum ActiveGitRoot {
    Unmanaged,
    Active(String),
    Stopped,
}

impl CommandGitBackend {
    pub fn new() -> Self {
        Self {
            cancellation_generation: Arc::new(AtomicU64::new(0)),
            active_root: Mutex::new(ActiveGitRoot::Unmanaged),
        }
    }

    fn scan_control(&self, root_id: &str) -> BackendResult<GitScanControl> {
        let expected_generation = self.cancellation_generation.load(Ordering::Acquire);
        let active_root = self.active_root.lock().map_err(|_| {
            BackendError::Platform("Git active-root coordination lock poisoned".into())
        })?;
        let selected = match &*active_root {
            ActiveGitRoot::Unmanaged => true,
            ActiveGitRoot::Active(active_root_id) => active_root_id == root_id,
            ActiveGitRoot::Stopped => false,
        };
        if !selected {
            return Err(cancelled_error());
        }
        drop(active_root);
        let control = GitScanControl {
            cancellation_generation: Arc::clone(&self.cancellation_generation),
            expected_generation,
            deadline: Instant::now() + GIT_SCAN_TIMEOUT,
        };
        control.check()?;
        Ok(control)
    }
}

impl Default for CommandGitBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl GitBackend for CommandGitBackend {
    fn activate_root(&self, root_id: &str) -> BackendResult<()> {
        let mut active_root = self.active_root.lock().map_err(|_| {
            BackendError::Platform("Git active-root coordination lock poisoned".into())
        })?;
        if !matches!(&*active_root, ActiveGitRoot::Active(active_root_id) if active_root_id == root_id)
        {
            *active_root = ActiveGitRoot::Active(root_id.to_string());
            self.cancellation_generation.fetch_add(1, Ordering::AcqRel);
        }
        Ok(())
    }

    fn cancel_pending(&self) {
        if let Ok(mut active_root) = self.active_root.lock() {
            *active_root = ActiveGitRoot::Stopped;
            self.cancellation_generation.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn scan(&self, root: &RootDescriptor, scan_generation: u32) -> BackendResult<GitSnapshotDto> {
        let control = self.scan_control(&root.root_id)?;
        let root_path = PathBuf::from(&root.root_path)
            .canonicalize()
            .map_err(|error| BackendError::Platform(format!("canonicalize Space root: {error}")))?;
        control.check()?;
        let mut candidates = vec![root_path.clone()];
        let children = std::fs::read_dir(&root_path)
            .map_err(|error| BackendError::Platform(format!("scan Space root: {error}")))?;
        for child in children {
            control.check()?;
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
            control.check()?;
            let Some(repository_root) = confirmed_repository_root(&candidate, &control)? else {
                continue;
            };
            if !repository_root.starts_with(&root_path) || !seen.insert(repository_root.clone()) {
                continue;
            }
            if candidate == root_path && repository_root != root_path {
                continue;
            }
            repositories.push(repository_status(&root_path, &repository_root, &control)?);
        }
        repositories.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(GitSnapshotDto {
            space_id: root.space_id.clone(),
            root_id: root.root_id.clone(),
            scan_generation,
            repositories,
        })
    }

    fn diff(
        &self,
        root: &RootDescriptor,
        repository: &GitRepositoryStatusDto,
        change: &GitFileChangeDto,
    ) -> BackendResult<GitFileDiffDto> {
        let control = self.scan_control(&root.root_id)?;
        let repository_root = validated_repository_root(root, repository, &control)?;
        validated_relative_path(&change.path)?;
        if let Some(original_path) = change.original_path.as_deref() {
            validated_relative_path(original_path)?;
        }
        control.check()?;
        if change.kind == "untracked" {
            untracked_file_diff(repository, change, &repository_root, &control)
        } else {
            tracked_file_diff(repository, change, &repository_root, &control)
        }
    }
}

fn validated_repository_root(
    root: &RootDescriptor,
    repository: &GitRepositoryStatusDto,
    control: &GitScanControl,
) -> BackendResult<PathBuf> {
    control.check()?;
    let space_root = PathBuf::from(&root.root_path)
        .canonicalize()
        .map_err(|error| BackendError::Platform(format!("canonicalize Space root: {error}")))?;
    let repository_root = PathBuf::from(&repository.root_path)
        .canonicalize()
        .map_err(|error| BackendError::Platform(format!("canonicalize Git root: {error}")))?;
    if !repository_root.starts_with(&space_root) {
        return Err(BackendError::Invalid(
            "Git repository is outside the Space root".into(),
        ));
    }
    let confirmed = confirmed_repository_root(&repository_root, control)?
        .ok_or_else(|| BackendError::NotFound(repository.root_path.clone()))?;
    if confirmed != repository_root || repository_id(&repository_root) != repository.repository_id {
        return Err(BackendError::Conflict(
            "Git repository identity changed; refresh Changes".into(),
        ));
    }
    Ok(repository_root)
}

fn validated_relative_path(value: &str) -> BackendResult<&Path> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(BackendError::Invalid(format!(
            "invalid repository-relative Git path: {value}"
        )));
    }
    Ok(path)
}

fn tracked_file_diff(
    repository: &GitRepositoryStatusDto,
    change: &GitFileChangeDto,
    repository_root: &Path,
    control: &GitScanControl,
) -> BackendResult<GitFileDiffDto> {
    let baseline = if repository_has_head(repository_root, control)? {
        "HEAD"
    } else {
        EMPTY_TREE
    };
    let mut arguments = vec![
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
        "--no-color".to_string(),
        "--unified=3".to_string(),
        "--find-renames".to_string(),
        "--find-copies".to_string(),
        baseline.to_string(),
        "--".to_string(),
    ];
    if let Some(original_path) = change
        .original_path
        .as_deref()
        .filter(|original_path| *original_path != change.path)
    {
        arguments.push(original_path.to_string());
    }
    arguments.push(change.path.clone());
    let output = git_output(repository_root, &arguments, control)?;
    if !output.status.success() {
        return Err(BackendError::Platform(format!(
            "read Git diff for {}: {}",
            change.path,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(diff_from_patch(repository, change, &output.stdout))
}

fn repository_has_head(repository_root: &Path, control: &GitScanControl) -> BackendResult<bool> {
    Ok(git_output(
        repository_root,
        &["rev-parse", "--verify", "HEAD^{tree}"],
        control,
    )?
    .status
    .success())
}

fn untracked_file_diff(
    repository: &GitRepositoryStatusDto,
    change: &GitFileChangeDto,
    repository_root: &Path,
    control: &GitScanControl,
) -> BackendResult<GitFileDiffDto> {
    control.check()?;
    let relative_path = validated_relative_path(&change.path)?;
    let file_path = repository_root.join(relative_path);
    let metadata = std::fs::symlink_metadata(&file_path)
        .map_err(|error| BackendError::Platform(format!("read {}: {error}", change.path)))?;
    if metadata.is_file() && metadata.len() > MAX_RENDERED_DIFF_BYTES as u64 {
        return Ok(GitFileDiffDto {
            repository_id: repository.repository_id.clone(),
            path: change.path.clone(),
            original_path: change.original_path.clone(),
            additions: 0,
            deletions: 0,
            binary: false,
            truncated: true,
            hunks: Vec::new(),
        });
    }
    let bytes = if metadata.file_type().is_symlink() {
        std::fs::read_link(&file_path)
            .map_err(|error| {
                BackendError::Platform(format!("read symlink {}: {error}", change.path))
            })?
            .to_string_lossy()
            .into_owned()
            .into_bytes()
    } else {
        control.check()?;
        let canonical_file = file_path.canonicalize().map_err(|error| {
            BackendError::Platform(format!("canonicalize {}: {error}", change.path))
        })?;
        if !canonical_file.starts_with(repository_root) {
            return Err(BackendError::Invalid(format!(
                "Git file is outside the repository: {}",
                change.path
            )));
        }
        std::fs::read(&canonical_file)
            .map_err(|error| BackendError::Platform(format!("read {}: {error}", change.path)))?
    };
    control.check()?;
    let truncated = bytes.len() > MAX_RENDERED_DIFF_BYTES;
    let binary = bytes.contains(&0);
    let additions = physical_line_count(&bytes);
    let mut diff = GitFileDiffDto {
        repository_id: repository.repository_id.clone(),
        path: change.path.clone(),
        original_path: change.original_path.clone(),
        additions,
        deletions: 0,
        binary,
        truncated,
        hunks: Vec::new(),
    };
    if binary || truncated || bytes.is_empty() {
        return Ok(diff);
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = Vec::new();
    let mut new_line = 1_u32;
    for raw_line in text.split_terminator('\n') {
        lines.push(GitDiffLineDto {
            kind: GitDiffLineKind::Added,
            old_line: None,
            new_line: Some(new_line),
            content: raw_line.strip_suffix('\r').unwrap_or(raw_line).to_string(),
        });
        new_line = new_line.saturating_add(1);
    }
    if !text.ends_with('\n') {
        lines.push(GitDiffLineDto {
            kind: GitDiffLineKind::Meta,
            old_line: None,
            new_line: None,
            content: "No newline at end of file".into(),
        });
    }
    diff.hunks.push(GitDiffHunkDto {
        header: format!("@@ -0,0 +1,{} @@", diff.additions),
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: diff.additions,
        lines,
    });
    Ok(diff)
}

fn physical_line_count(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count();
    let count = newlines + usize::from(bytes.last() != Some(&b'\n'));
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn diff_from_patch(
    repository: &GitRepositoryStatusDto,
    change: &GitFileChangeDto,
    bytes: &[u8],
) -> GitFileDiffDto {
    let text = String::from_utf8_lossy(bytes);
    let binary = text.lines().any(|line| {
        line.starts_with("Binary files ")
            || line == "GIT binary patch"
            || line.starts_with("Submodule ")
    });
    let truncated = bytes.len() > MAX_RENDERED_DIFF_BYTES;
    if binary || truncated {
        let (additions, deletions) = count_patch_changes(&text);
        return GitFileDiffDto {
            repository_id: repository.repository_id.clone(),
            path: change.path.clone(),
            original_path: change.original_path.clone(),
            additions,
            deletions,
            binary,
            truncated,
            hunks: Vec::new(),
        };
    }

    let mut hunks = Vec::new();
    let mut current: Option<GitDiffHunkDto> = None;
    let mut old_line = 0_u32;
    let mut new_line = 0_u32;
    let mut additions = 0_u32;
    let mut deletions = 0_u32;

    for raw_line in text.split_terminator('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some((old_start, old_lines, new_start, new_lines)) = parse_hunk_header(line) {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            old_line = old_start;
            new_line = new_start;
            current = Some(GitDiffHunkDto {
                header: line.to_string(),
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines: Vec::new(),
            });
            continue;
        }
        if line.starts_with("diff --git ") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            continue;
        }
        let Some(hunk) = current.as_mut() else {
            continue;
        };
        if let Some(content) = line.strip_prefix('+') {
            hunk.lines.push(GitDiffLineDto {
                kind: GitDiffLineKind::Added,
                old_line: None,
                new_line: Some(new_line),
                content: content.to_string(),
            });
            additions = additions.saturating_add(1);
            new_line = new_line.saturating_add(1);
        } else if let Some(content) = line.strip_prefix('-') {
            hunk.lines.push(GitDiffLineDto {
                kind: GitDiffLineKind::Deleted,
                old_line: Some(old_line),
                new_line: None,
                content: content.to_string(),
            });
            deletions = deletions.saturating_add(1);
            old_line = old_line.saturating_add(1);
        } else if let Some(content) = line.strip_prefix(' ') {
            hunk.lines.push(GitDiffLineDto {
                kind: GitDiffLineKind::Context,
                old_line: Some(old_line),
                new_line: Some(new_line),
                content: content.to_string(),
            });
            old_line = old_line.saturating_add(1);
            new_line = new_line.saturating_add(1);
        } else if let Some(content) = line.strip_prefix("\\ ") {
            hunk.lines.push(GitDiffLineDto {
                kind: GitDiffLineKind::Meta,
                old_line: None,
                new_line: None,
                content: content.to_string(),
            });
        }
    }
    if let Some(hunk) = current {
        hunks.push(hunk);
    }

    GitFileDiffDto {
        repository_id: repository.repository_id.clone(),
        path: change.path.clone(),
        original_path: change.original_path.clone(),
        additions,
        deletions,
        binary,
        truncated,
        hunks,
    }
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let ranges = line.strip_prefix("@@ ")?.split_once(" @@")?.0;
    let mut parts = ranges.split_whitespace();
    let (old_start, old_lines) = parse_hunk_range(parts.next()?, '-')?;
    let (new_start, new_lines) = parse_hunk_range(parts.next()?, '+')?;
    Some((old_start, old_lines, new_start, new_lines))
}

fn parse_hunk_range(value: &str, prefix: char) -> Option<(u32, u32)> {
    let value = value.strip_prefix(prefix)?;
    let (start, count) = value
        .split_once(',')
        .map(|(start, count)| (start, count))
        .unwrap_or((value, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}

fn count_patch_changes(text: &str) -> (u32, u32) {
    let mut in_hunk = false;
    let mut additions = 0_u32;
    let mut deletions = 0_u32;
    for line in text.lines() {
        if parse_hunk_header(line).is_some() {
            in_hunk = true;
        } else if line.starts_with("diff --git ") {
            in_hunk = false;
        } else if in_hunk && line.starts_with('+') {
            additions = additions.saturating_add(1);
        } else if in_hunk && line.starts_with('-') {
            deletions = deletions.saturating_add(1);
        }
    }
    (additions, deletions)
}

fn confirmed_repository_root(
    candidate: &Path,
    control: &GitScanControl,
) -> BackendResult<Option<PathBuf>> {
    let output = git_output(candidate, &["rev-parse", "--show-toplevel"], control)?;
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

fn repository_status(
    space_root: &Path,
    repository_root: &Path,
    control: &GitScanControl,
) -> BackendResult<GitRepositoryStatusDto> {
    let relative_path = repository_root
        .strip_prefix(space_root)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .map(path_to_slashes)
        .unwrap_or_else(|| ".".into());
    let root_path = repository_root.to_string_lossy().to_string();
    let repository_id = repository_id(repository_root);
    let captured_at = now_timestamp();
    match git_output(
        repository_root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--no-ahead-behind",
            "--untracked-files=all",
        ],
        control,
    ) {
        Ok(output) if output.status.success() => {
            let (branch, files) = parse_porcelain_v2(&output.stdout);
            Ok(GitRepositoryStatusDto {
                repository_id,
                relative_path,
                root_path,
                branch,
                files,
                captured_at,
                error: None,
            })
        }
        Ok(output) => Ok(GitRepositoryStatusDto {
            repository_id,
            relative_path,
            root_path,
            branch: None,
            files: Vec::new(),
            captured_at,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        }),
        Err(error) => Err(error),
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

#[derive(Clone)]
struct GitScanControl {
    cancellation_generation: Arc<AtomicU64>,
    expected_generation: u64,
    deadline: Instant,
}

impl GitScanControl {
    fn check(&self) -> BackendResult<()> {
        if self.cancellation_generation.load(Ordering::Acquire) != self.expected_generation {
            return Err(cancelled_error());
        }
        if Instant::now() >= self.deadline {
            return Err(timeout_error());
        }
        Ok(())
    }
}

fn git_output<S: AsRef<OsStr>>(
    cwd: &Path,
    arguments: &[S],
    control: &GitScanControl,
) -> BackendResult<Output> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .args(arguments);
    run_command(&mut command, control, GIT_STREAM_LIMIT_BYTES)
}

fn run_command(
    command: &mut Command,
    control: &GitScanControl,
    stream_limit_bytes: usize,
) -> BackendResult<Output> {
    control.check()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| BackendError::Platform(format!("run Git: {error}")))?;
    let containment = ProcessContainment::attach(Some(child.id())).inspect_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| BackendError::Platform("capture Git stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| BackendError::Platform("capture Git stderr".into()))?;
    let output_limit_exceeded = Arc::new(AtomicBool::new(false));
    let stdout_limit = Arc::clone(&output_limit_exceeded);
    let stderr_limit = Arc::clone(&output_limit_exceeded);
    let stdout_reader =
        thread::spawn(move || read_limited_stream(stdout, stream_limit_bytes, stdout_limit));
    let stderr_reader =
        thread::spawn(move || read_limited_stream(stderr, stream_limit_bytes, stderr_limit));

    loop {
        let stop_error = if control.cancellation_generation.load(Ordering::Acquire)
            != control.expected_generation
        {
            Some(cancelled_error())
        } else if Instant::now() >= control.deadline {
            Some(timeout_error())
        } else if output_limit_exceeded.load(Ordering::Acquire) {
            Some(BackendError::Platform(format!(
                "Git command output exceeded {stream_limit_bytes} bytes per stream"
            )))
        } else {
            None
        };
        if let Some(error) = stop_error {
            terminate_command(&mut child, &containment);
            let _ = join_stream_reader(stdout_reader, "stdout");
            let _ = join_stream_reader(stderr_reader, "stderr");
            return Err(error);
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = join_stream_reader(stdout_reader, "stdout")?;
                let stderr = join_stream_reader(stderr_reader, "stderr")?;
                if output_limit_exceeded.load(Ordering::Acquire) {
                    return Err(BackendError::Platform(format!(
                        "Git command output exceeded {stream_limit_bytes} bytes per stream"
                    )));
                }
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => thread::sleep(GIT_WAIT_INTERVAL),
            Err(error) => {
                terminate_command(&mut child, &containment);
                let _ = join_stream_reader(stdout_reader, "stdout");
                let _ = join_stream_reader(stderr_reader, "stderr");
                return Err(BackendError::Platform(format!(
                    "wait for Git command: {error}"
                )));
            }
        }
    }
}

fn read_limited_stream(
    mut reader: impl Read,
    limit_bytes: usize,
    output_limit_exceeded: Arc<AtomicBool>,
) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(output);
        }
        let remaining = limit_bytes.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..read.min(remaining)]);
        if read > remaining {
            output_limit_exceeded.store(true, Ordering::Release);
            return Ok(output);
        }
    }
}

fn join_stream_reader(
    reader: thread::JoinHandle<io::Result<Vec<u8>>>,
    stream_name: &str,
) -> BackendResult<Vec<u8>> {
    reader
        .join()
        .map_err(|_| BackendError::Platform(format!("Git {stream_name} reader panicked")))?
        .map_err(|error| BackendError::Platform(format!("read Git {stream_name}: {error}")))
}

fn terminate_command(child: &mut std::process::Child, containment: &ProcessContainment) {
    let _ = containment.terminate();
    let _ = child.kill();
    let _ = child.wait();
}

fn cancelled_error() -> BackendError {
    BackendError::Platform("Git scan cancelled because the active Space root changed".into())
}

fn timeout_error() -> BackendError {
    BackendError::Platform(format!(
        "Git scan exceeded {}ms",
        GIT_SCAN_TIMEOUT.as_millis()
    ))
}

fn repository_id(repository_root: &Path) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        repository_root.to_string_lossy().as_bytes(),
    )
    .to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activating_a_new_root_cancels_the_previous_scan_control() {
        let backend = CommandGitBackend::new();
        backend.activate_root("root-a").unwrap();
        let previous = backend.scan_control("root-a").unwrap();

        backend.activate_root("root-b").unwrap();

        assert!(
            previous
                .check()
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
        assert!(backend.scan_control("root-a").is_err());
        assert!(backend.scan_control("root-b").is_ok());
    }

    #[test]
    fn reactivating_the_same_root_preserves_the_scan_control() {
        let backend = CommandGitBackend::new();
        backend.activate_root("root-a").unwrap();
        let control = backend.scan_control("root-a").unwrap();

        backend.activate_root("root-a").unwrap();

        control.check().unwrap();
    }

    #[test]
    fn command_runner_terminates_work_at_the_deadline() {
        let generation = Arc::new(AtomicU64::new(0));
        let control = GitScanControl {
            cancellation_generation: generation,
            expected_generation: 0,
            deadline: Instant::now() + Duration::from_millis(100),
        };
        let started_at = Instant::now();

        let error = run_command(&mut long_running_command(), &control, 1024)
            .expect_err("long-running command should time out");

        assert!(error.to_string().contains("exceeded"));
        assert!(started_at.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn command_runner_terminates_work_when_cancelled() {
        let generation = Arc::new(AtomicU64::new(0));
        let worker_generation = Arc::clone(&generation);
        let worker = thread::spawn(move || {
            let control = GitScanControl {
                cancellation_generation: worker_generation,
                expected_generation: 0,
                deadline: Instant::now() + Duration::from_secs(5),
            };
            run_command(&mut long_running_command(), &control, 1024)
        });
        thread::sleep(Duration::from_millis(100));
        let cancelled_at = Instant::now();

        generation.fetch_add(1, Ordering::AcqRel);
        let error = worker
            .join()
            .unwrap()
            .expect_err("cancelled command should stop");

        assert!(error.to_string().contains("cancelled"));
        assert!(cancelled_at.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn command_runner_bounds_captured_output() {
        let control = GitScanControl {
            cancellation_generation: Arc::new(AtomicU64::new(0)),
            expected_generation: 0,
            deadline: Instant::now() + Duration::from_secs(5),
        };

        let error = run_command(&mut output_command(), &control, 1024)
            .expect_err("large command output should be bounded");

        assert!(error.to_string().contains("output exceeded 1024 bytes"));
    }

    #[cfg(unix)]
    fn long_running_command() -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 60 & wait"]);
        command
    }

    #[cfg(unix)]
    fn output_command() -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "yes 0123456789"]);
        command
    }

    #[cfg(windows)]
    fn long_running_command() -> Command {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "ping -n 60 127.0.0.1 >NUL"]);
        command
    }

    #[cfg(windows)]
    fn output_command() -> Command {
        let mut command = Command::new("cmd.exe");
        command.args([
            "/D",
            "/S",
            "/C",
            "for /L %i in (1,1,100000) do @echo 0123456789",
        ]);
        command
    }
}
