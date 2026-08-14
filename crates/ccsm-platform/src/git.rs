use std::{
    collections::HashSet,
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
    dto::{GitFileChangeDto, GitRepositoryStatusDto, GitSnapshotDto},
    error::{BackendError, BackendResult},
    ports::{GitBackend, RootDescriptor},
};
use uuid::Uuid;

use crate::containment::ProcessContainment;

const GIT_SCAN_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_STREAM_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const GIT_WAIT_INTERVAL: Duration = Duration::from_millis(10);

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
    let repository_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, root_path.as_bytes()).to_string();
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

fn git_output(cwd: &Path, arguments: &[&str], control: &GitScanControl) -> BackendResult<Output> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
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
