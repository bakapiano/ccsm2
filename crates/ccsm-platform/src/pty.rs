use std::{
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use ccsm_core::{
    dto::ProviderKind,
    error::{BackendError, BackendResult},
    ports::{PtyBackend, PtyEvent, PtyEventSink, PtyProcess, PtySpawnSpec},
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};

use crate::containment::ProcessContainment;

const RUNTIME_SHIM_ROOT_PREFIX: &str = "ccsm-runtime-shims-";
const PTY_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const PTY_JOIN_POLL_INTERVAL: Duration = Duration::from_millis(5);
const PTY_READ_BUFFER_BYTES: usize = 8 * 1024;
const PROVIDER_RUNTIME_ENVIRONMENT: [&str; 9] = [
    "CCSM_WRAPPER_ACTIVE",
    "CCSM_PROVIDER",
    "CCSM_SESSION_ID",
    "CCSM_RUNTIME_ID",
    "CCSM_HOOK_PIPE",
    "CCSM_HOOK_TOKEN",
    "CCSM_HOOK_REPORTER",
    "CCSM_NATIVE_SESSION_ID",
    "CCSM_COPILOT_PLUGIN_DIR",
];

fn clear_inherited_provider_runtime_environment(command: &mut CommandBuilder) {
    for name in PROVIDER_RUNTIME_ENVIRONMENT {
        command.env_remove(name);
    }
}

pub fn cleanup_stale_runtime_shim_roots(parent: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(owner_pid) = runtime_shim_owner_pid(&entry.file_name()) else {
            continue;
        };
        if owner_pid == std::process::id() || process_is_alive(owner_pid) {
            continue;
        }
        let Ok(metadata) = path.symlink_metadata() else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&path) {
            eprintln!(
                "CCSM could not remove stale runtime shim root {}: {error}",
                path.display()
            );
        }
    }
}

fn runtime_shim_owner_pid(name: &std::ffi::OsStr) -> Option<u32> {
    name.to_str()?
        .strip_prefix(RUNTIME_SHIM_ROOT_PREFIX)?
        .parse()
        .ok()
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };

    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return std::io::Error::last_os_error().raw_os_error()
            != Some(ERROR_INVALID_PARAMETER as i32);
    }
    let result = unsafe { WaitForSingleObject(process, 0) };
    unsafe { CloseHandle(process) };
    result == WAIT_TIMEOUT
}

#[cfg(not(windows))]
fn process_is_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

enum InputCommand {
    Input(Vec<u8>),
    Shutdown,
}

enum ResizeCommand {
    Wake,
    Shutdown,
}

pub struct PortablePtyBackend {
    shim_root: PathBuf,
    executable: PathBuf,
    claude_model: Option<String>,
    claude_base_url: Option<String>,
    raw_claude_path: Option<String>,
}

impl PortablePtyBackend {
    pub fn new(shim_root: PathBuf, executable: PathBuf) -> BackendResult<Self> {
        std::fs::create_dir_all(&shim_root).map_err(|error| {
            BackendError::Platform(format!(
                "create CLI shim root {}: {error}",
                shim_root.display()
            ))
        })?;
        Ok(Self {
            shim_root,
            executable,
            claude_model: None,
            claude_base_url: None,
            raw_claude_path: None,
        })
    }

    pub fn with_claude_overrides(
        mut self,
        model: Option<String>,
        base_url: Option<String>,
        raw_claude_path: Option<String>,
    ) -> Self {
        self.claude_model = model;
        self.claude_base_url = base_url;
        self.raw_claude_path = raw_claude_path;
        self
    }
}

struct PortablePtyProcess {
    pid: Option<u32>,
    shell: String,
    input_tx: mpsc::Sender<InputCommand>,
    resize_tx: mpsc::SyncSender<ResizeCommand>,
    resize_shutdown: Arc<AtomicBool>,
    pending_resize: Arc<Mutex<Option<(u16, u16)>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    containment: ProcessContainment,
    watchdog: ProcessWatchdog,
    threads: Mutex<PortablePtyThreads>,
    _runtime_shim: Option<RuntimeShim>,
}

struct PortablePtyThreads {
    shutdown_started: bool,
    input: Option<JoinHandle<()>>,
    resize: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    waiter: Option<JoinHandle<()>>,
}

impl PortablePtyProcess {
    fn shutdown_resources(&self) -> BackendResult<()> {
        let mut threads = self
            .threads
            .lock()
            .map_err(|_| BackendError::Platform("PTY thread lock poisoned".into()))?;
        if threads.shutdown_started {
            return Ok(());
        }
        threads.shutdown_started = true;
        let deadline = Instant::now() + PTY_SHUTDOWN_TIMEOUT;

        let mut first_error = self.containment.terminate().err();
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
        if let Err(error) = self.watchdog.shutdown(deadline)
            && first_error.is_none()
        {
            first_error = Some(error);
        }

        let _ = self.input_tx.send(InputCommand::Shutdown);
        self.resize_shutdown.store(true, Ordering::Release);
        let _ = self.resize_tx.try_send(ResizeCommand::Shutdown);

        join_thread_until(&mut threads.input, "input", deadline, &mut first_error);
        join_thread_until(&mut threads.resize, "resize", deadline, &mut first_error);
        join_thread_until(&mut threads.reader, "reader", deadline, &mut first_error);
        join_thread_until(&mut threads.waiter, "waiter", deadline, &mut first_error);

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn join_thread_until(
    thread: &mut Option<JoinHandle<()>>,
    name: &str,
    deadline: Instant,
    first_error: &mut Option<BackendError>,
) {
    let Some(handle) = thread.take() else {
        return;
    };
    while !handle.is_finished() && Instant::now() < deadline {
        thread::sleep(
            PTY_JOIN_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    if !handle.is_finished() {
        if first_error.is_none() {
            *first_error = Some(BackendError::Platform(format!(
                "PTY {name} thread exceeded the {}ms shutdown deadline",
                PTY_SHUTDOWN_TIMEOUT.as_millis()
            )));
        }
        return;
    }
    if handle.join().is_err() && first_error.is_none() {
        *first_error = Some(BackendError::Platform(format!(
            "PTY {name} thread panicked during shutdown"
        )));
    }
}

impl PtyProcess for PortablePtyProcess {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn shell_label(&self) -> &str {
        &self.shell
    }

    fn engine_label(&self) -> &str {
        "portable-pty byte proxy → ghostty-web/WASM"
    }

    fn write(&self, data: Vec<u8>) -> BackendResult<()> {
        self.input_tx
            .send(InputCommand::Input(data))
            .map_err(|_| BackendError::Platform("PTY engine stopped".into()))
    }

    fn resize(&self, cols: u16, rows: u16) -> BackendResult<()> {
        queue_resize(&self.pending_resize, &self.resize_tx, cols, rows)
    }

    fn stop(&self) -> BackendResult<()> {
        self.shutdown_resources()
    }

    fn shutdown(&self) -> BackendResult<()> {
        self.shutdown_resources()
    }
}

impl Drop for PortablePtyProcess {
    fn drop(&mut self) {
        let _ = self.shutdown_resources();
    }
}

impl PtyBackend for PortablePtyBackend {
    fn spawn(
        &self,
        spec: PtySpawnSpec,
        event_sink: PtyEventSink,
    ) -> BackendResult<Arc<dyn PtyProcess>> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: spec.rows.max(1),
                cols: spec.cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| BackendError::Platform(format!("open PTY failed: {error:#}")))?;

        let (program, args, shell_label, runtime_shim) = match spec.provider {
            ProviderKind::Shell => {
                let (shell, args) = default_shell();
                let label = shell.display().to_string();
                (shell, args, label, None)
            }
            ProviderKind::Claude | ProviderKind::Codex | ProviderKind::Copilot => {
                let hook = spec.hook.as_ref().ok_or_else(|| {
                    BackendError::Platform("agent CLI launch has no Hook context".into())
                })?;
                let runtime_shim = RuntimeShim::create(
                    &self.shim_root,
                    &self.executable,
                    &hook.runtime_id,
                    spec.provider,
                )?;
                let (program, args) = runtime_shim.provider_command();
                (
                    program,
                    args,
                    provider_label(spec.provider).to_string(),
                    Some(runtime_shim),
                )
            }
        };
        let mut command = CommandBuilder::new(&program);
        command.args(args);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        if let Some(runtime_shim) = runtime_shim.as_ref() {
            clear_inherited_provider_runtime_environment(&mut command);
            let current_path = env::var_os("PATH").unwrap_or_default();
            let mut paths = vec![runtime_shim.directory.clone()];
            paths.extend(env::split_paths(&current_path));
            let path = env::join_paths(paths).map_err(|error| {
                BackendError::Platform(format!("assemble CLI shim PATH: {error}"))
            })?;
            command.env("PATH", path);
            let hook = spec.hook.as_ref().expect("agent launch has Hook context");
            command.env("CCSM_PROVIDER", provider_text(spec.provider));
            command.env("CCSM_SESSION_ID", &hook.cli_session_id);
            command.env("CCSM_RUNTIME_ID", &hook.runtime_id);
            command.env("CCSM_HOOK_PIPE", &hook.endpoint);
            command.env("CCSM_HOOK_TOKEN", &hook.token);
            command.env("CCSM_HOOK_REPORTER", &runtime_shim.hook_executable);
            if let Some(plugin_dir) = runtime_shim.copilot_plugin_dir() {
                command.env("CCSM_COPILOT_PLUGIN_DIR", plugin_dir);
            }
            if spec.provider == ProviderKind::Claude {
                if let Some(model) = self.claude_model.as_ref() {
                    command.env("CCSM_CLAUDE_MODEL", model);
                }
                if let Some(base_url) = self.claude_base_url.as_ref() {
                    command.env("CCSM_CLAUDE_BASE_URL", base_url);
                }
                if let Some(raw_claude_path) = self.raw_claude_path.as_ref() {
                    command.env("CCSM_REAL_CLAUDE_PATH", raw_claude_path);
                }
            }
            if let Some(native_session_id) = spec.native_session_id.as_ref() {
                command.env("CCSM_NATIVE_SESSION_ID", native_session_id);
            }
        }
        let process_cwd = process_path(&spec.cwd);
        if process_cwd.is_dir() {
            command.cwd(process_cwd);
        }

        let mut child = pair.slave.spawn_command(command).map_err(|error| {
            BackendError::Platform(format!("spawn {} failed: {error:#}", program.display()))
        })?;
        let pid = child.process_id();
        let containment = ProcessContainment::attach(pid)?;
        let watchdog = match ProcessWatchdog::spawn(&self.executable, pid) {
            Ok(watchdog) => watchdog,
            Err(error) => {
                let _ = containment.terminate();
                let _ = child.kill();
                return Err(error);
            }
        };
        let killer = child.clone_killer();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|error| {
            BackendError::Platform(format!("clone PTY reader failed: {error:#}"))
        })?;
        let writer = pair.master.take_writer().map_err(|error| {
            BackendError::Platform(format!("take PTY writer failed: {error:#}"))
        })?;
        let (input_tx, input_rx) = mpsc::channel();
        let (resize_tx, resize_rx) = mpsc::sync_channel(1);
        let resize_shutdown = Arc::new(AtomicBool::new(false));
        let pending_resize = Arc::new(Mutex::new(None));

        let input_events = Arc::clone(&event_sink);
        let input_thread = thread::Builder::new()
            .name("ccsm-pty-input".into())
            .spawn(move || run_input(writer, input_rx, input_events))
            .map_err(|error| BackendError::Platform(format!("start PTY input failed: {error}")))?;

        let resize_events = Arc::clone(&event_sink);
        let resize_pending = Arc::clone(&pending_resize);
        let resize_stop = Arc::clone(&resize_shutdown);
        let resize_thread = thread::Builder::new()
            .name("ccsm-pty-resize".into())
            .spawn(move || {
                run_resize(
                    pair.master,
                    resize_rx,
                    resize_pending,
                    resize_stop,
                    resize_events,
                )
            })
            .map_err(|error| BackendError::Platform(format!("start PTY resize failed: {error}")))?;

        let reader_events = Arc::clone(&event_sink);
        let (reader_done_tx, reader_done_rx) = mpsc::channel();
        let reader_thread = thread::Builder::new()
            .name("ccsm-pty-reader".into())
            .spawn(move || {
                let mut buffer = vec![0_u8; PTY_READ_BUFFER_BYTES];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(length) => reader_events(PtyEvent::Output(buffer[..length].to_vec())),
                        Err(error) => {
                            reader_events(PtyEvent::Error(error.to_string()));
                            break;
                        }
                    }
                }
                let _ = reader_done_tx.send(());
            })
            .map_err(|error| BackendError::Platform(format!("start PTY reader failed: {error}")))?;

        let waiter_thread = thread::Builder::new()
            .name("ccsm-pty-waiter".into())
            .spawn(move || {
                let code = child.wait().map_or(1, |status| status.exit_code());
                let _ = reader_done_rx.recv_timeout(Duration::from_millis(750));
                event_sink(PtyEvent::Exit(code));
            })
            .map_err(|error| BackendError::Platform(format!("start PTY waiter failed: {error}")))?;

        Ok(Arc::new(PortablePtyProcess {
            pid,
            shell: shell_label,
            input_tx,
            resize_tx,
            resize_shutdown,
            pending_resize,
            killer: Mutex::new(killer),
            containment,
            watchdog,
            threads: Mutex::new(PortablePtyThreads {
                shutdown_started: false,
                input: Some(input_thread),
                resize: Some(resize_thread),
                reader: Some(reader_thread),
                waiter: Some(waiter_thread),
            }),
            _runtime_shim: runtime_shim,
        }))
    }
}

#[cfg(unix)]
struct ProcessWatchdog {
    stdin: Mutex<Option<std::process::ChildStdin>>,
    child: Mutex<Option<std::process::Child>>,
}

#[cfg(unix)]
impl ProcessWatchdog {
    fn spawn(executable: &Path, pid: Option<u32>) -> BackendResult<Self> {
        use std::process::{Command, Stdio};

        let pgid =
            pid.ok_or_else(|| BackendError::Platform("spawned process has no PID".into()))?;
        let mut child = Command::new(executable)
            .args(["process-watchdog", &pgid.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| BackendError::Platform(format!("start process watchdog: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BackendError::Platform("process watchdog has no control pipe".into()))?;
        Ok(Self {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
        })
    }

    fn shutdown(&self, deadline: Instant) -> BackendResult<()> {
        self.stdin
            .lock()
            .map_err(|_| BackendError::Platform("process watchdog pipe lock poisoned".into()))?
            .take();
        if let Some(mut child) = self
            .child
            .lock()
            .map_err(|_| BackendError::Platform("process watchdog lock poisoned".into()))?
            .take()
        {
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(
                            PTY_JOIN_POLL_INTERVAL
                                .min(deadline.saturating_duration_since(Instant::now())),
                        );
                    }
                    Ok(None) => {
                        let _ = child.kill();
                        thread::spawn(move || {
                            let _ = child.wait();
                        });
                        return Err(BackendError::Platform(format!(
                            "process watchdog exceeded the {}ms shutdown deadline",
                            PTY_SHUTDOWN_TIMEOUT.as_millis()
                        )));
                    }
                    Err(error) => {
                        return Err(BackendError::Platform(format!(
                            "poll process watchdog: {error}"
                        )));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
struct ProcessWatchdog;

#[cfg(windows)]
impl ProcessWatchdog {
    fn spawn(_executable: &Path, _pid: Option<u32>) -> BackendResult<Self> {
        Ok(Self)
    }

    fn shutdown(&self, _deadline: Instant) -> BackendResult<()> {
        Ok(())
    }
}

struct RuntimeShim {
    directory: PathBuf,
    provider_executable: PathBuf,
    hook_executable: PathBuf,
    copilot_plugin_directory: Option<PathBuf>,
}

impl RuntimeShim {
    fn create(
        root: &Path,
        source: &Path,
        runtime_id: &str,
        provider: ProviderKind,
    ) -> BackendResult<Self> {
        if !runtime_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(BackendError::Invalid("runtime ID is not path-safe".into()));
        }
        let directory = root.join(runtime_id);
        std::fs::create_dir(&directory).map_err(|error| {
            BackendError::Platform(format!(
                "create runtime shim directory {}: {error}",
                directory.display()
            ))
        })?;
        let provider_executable = create_provider_shim(&directory, source, provider)?;
        let hook_executable = create_hook_shim(&directory, source)?;
        let copilot_plugin_directory = if provider == ProviderKind::Copilot {
            Some(create_copilot_plugin(
                &directory,
                &hook_executable,
                runtime_id,
            )?)
        } else {
            None
        };
        Ok(Self {
            directory,
            provider_executable,
            hook_executable,
            copilot_plugin_directory,
        })
    }

    fn provider_command(&self) -> (PathBuf, Vec<String>) {
        (self.provider_executable.clone(), Vec::new())
    }

    fn copilot_plugin_dir(&self) -> Option<&Path> {
        self.copilot_plugin_directory.as_deref()
    }
}

impl Drop for RuntimeShim {
    fn drop(&mut self) {
        if let Some(plugin_directory) = self.copilot_plugin_directory.as_ref() {
            let _ = std::fs::remove_dir_all(plugin_directory);
        }
        let _ = std::fs::remove_file(&self.provider_executable);
        let _ = std::fs::remove_file(&self.hook_executable);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn link_or_copy(source: &Path, destination: &Path) -> std::io::Result<()> {
    match std::fs::hard_link(source, destination) {
        Ok(()) => Ok(()),
        Err(_) => std::fs::copy(source, destination).map(|_| ()),
    }
}

#[cfg(windows)]
fn provider_shim_name() -> String {
    "ccsm-provider.exe".into()
}

#[cfg(not(windows))]
fn provider_shim_name() -> String {
    "ccsm-provider".into()
}

fn create_provider_shim(
    directory: &Path,
    source: &Path,
    provider: ProviderKind,
) -> BackendResult<PathBuf> {
    let path = directory.join(provider_shim_name());
    link_or_copy(source, &path).map_err(|error| {
        BackendError::Platform(format!(
            "create {} provider shim: {error}",
            provider_text(provider)
        ))
    })?;
    Ok(path)
}

#[cfg(windows)]
fn create_hook_shim(directory: &Path, source: &Path) -> BackendResult<PathBuf> {
    let path = directory.join("ccsm-hook.exe");
    link_or_copy(source, &path)
        .map_err(|error| BackendError::Platform(format!("create Hook shim: {error}")))?;
    Ok(path)
}

fn create_copilot_plugin(
    runtime_directory: &Path,
    hook_executable: &Path,
    runtime_id: &str,
) -> BackendResult<PathBuf> {
    let plugin_directory = runtime_directory.join("copilot-hook-plugin");
    std::fs::create_dir(&plugin_directory).map_err(|error| {
        BackendError::Platform(format!("create Copilot Hook plugin directory: {error}"))
    })?;
    let hook = copilot_hook_entry(hook_executable);
    let mut notification = hook.clone();
    notification
        .as_object_mut()
        .expect("Copilot Hook entry is an object")
        .insert(
            "matcher".into(),
            Value::String("permission_prompt|elicitation_dialog".into()),
        );
    let manifest = json!({
        "name": format!("ccsm-runtime-{runtime_id}"),
        "version": "1.0.0",
        "hooks": "hooks.json"
    });
    let hooks = json!({
        "version": 1,
        "hooks": {
            "SessionStart": [hook.clone()],
            "UserPromptSubmit": [hook.clone()],
            "PreToolUse": [hook.clone()],
            "Stop": [hook.clone()],
            "SessionEnd": [hook],
            "notification": [notification]
        }
    });
    write_json_file(&plugin_directory.join("plugin.json"), &manifest)?;
    write_json_file(&plugin_directory.join("hooks.json"), &hooks)?;
    Ok(plugin_directory)
}

fn write_json_file(path: &Path, value: &Value) -> BackendResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| BackendError::Platform(format!("encode {}: {error}", path.display())))?;
    std::fs::write(path, bytes)
        .map_err(|error| BackendError::Platform(format!("write {}: {error}", path.display())))
}

#[cfg(windows)]
fn copilot_hook_entry(hook_executable: &Path) -> Value {
    let path = hook_executable.to_string_lossy().replace('\'', "''");
    json!({
        "type": "command",
        "powershell": format!("& '{path}' hook report"),
        "timeoutSec": 10
    })
}

#[cfg(not(windows))]
fn copilot_hook_entry(hook_executable: &Path) -> Value {
    let path = hook_executable.to_string_lossy().replace('\'', "'\\''");
    json!({
        "type": "command",
        "bash": format!("'{path}' hook report"),
        "timeoutSec": 10
    })
}

#[cfg(not(windows))]
fn create_hook_shim(directory: &Path, source: &Path) -> BackendResult<PathBuf> {
    let path = directory.join("ccsm-hook");
    link_or_copy(source, &path)
        .map_err(|error| BackendError::Platform(format!("create Hook shim: {error}")))?;
    Ok(path)
}

fn provider_text(provider: ProviderKind) -> &'static str {
    match provider {
        ProviderKind::Shell => "shell",
        ProviderKind::Claude => "claude",
        ProviderKind::Codex => "codex",
        ProviderKind::Copilot => "copilot",
    }
}

fn provider_label(provider: ProviderKind) -> &'static str {
    match provider {
        ProviderKind::Shell => "Shell",
        ProviderKind::Claude => "Claude Code",
        ProviderKind::Codex => "Codex",
        ProviderKind::Copilot => "GitHub Copilot",
    }
}

#[cfg(windows)]
fn process_path(value: &str) -> PathBuf {
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{path}"));
    }
    PathBuf::from(value.strip_prefix(r"\\?\").unwrap_or(value))
}

#[cfg(not(windows))]
fn process_path(value: &str) -> PathBuf {
    PathBuf::from(value)
}

fn run_input(
    mut writer: Box<dyn Write + Send>,
    commands: mpsc::Receiver<InputCommand>,
    event_sink: PtyEventSink,
) {
    while let Ok(command) = commands.recv() {
        match command {
            InputCommand::Input(data) => {
                if let Err(error) = writer.write_all(&data).and_then(|()| writer.flush()) {
                    event_sink(PtyEvent::Error(format!("PTY input failed: {error}")));
                    break;
                }
            }
            InputCommand::Shutdown => break,
        }
    }
}

fn run_resize(
    master: Box<dyn MasterPty + Send>,
    commands: mpsc::Receiver<ResizeCommand>,
    pending_resize: Arc<Mutex<Option<(u16, u16)>>>,
    shutdown: Arc<AtomicBool>,
    event_sink: PtyEventSink,
) {
    while let Ok(command) = commands.recv() {
        if shutdown.load(Ordering::Acquire) {
            break;
        }
        match command {
            ResizeCommand::Wake => loop {
                if shutdown.load(Ordering::Acquire) {
                    return;
                }
                let size = pending_resize.lock().ok().and_then(|mut size| size.take());
                let Some((cols, rows)) = size else {
                    break;
                };
                if let Err(error) = master.resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(2),
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    event_sink(PtyEvent::Error(format!("PTY resize failed: {error:#}")));
                    return;
                }
                match commands.try_recv() {
                    Ok(ResizeCommand::Shutdown) => return,
                    Ok(ResizeCommand::Wake)
                    | Err(mpsc::TryRecvError::Empty)
                    | Err(mpsc::TryRecvError::Disconnected) => {}
                }
            },
            ResizeCommand::Shutdown => break,
        }
    }
}

fn queue_resize(
    pending_resize: &Mutex<Option<(u16, u16)>>,
    resize_tx: &mpsc::SyncSender<ResizeCommand>,
    cols: u16,
    rows: u16,
) -> BackendResult<()> {
    *pending_resize
        .lock()
        .map_err(|_| BackendError::Platform("PTY resize lock poisoned".into()))? =
        Some((cols.max(2), rows.max(1)));
    match resize_tx.try_send(ResizeCommand::Wake) {
        Ok(()) | Err(mpsc::TrySendError::Full(_)) => Ok(()),
        Err(mpsc::TrySendError::Disconnected(_)) => {
            Err(BackendError::Platform("PTY resize engine stopped".into()))
        }
    }
}

#[cfg(windows)]
fn find_on_path(program: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|directory| directory.join(program))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn default_shell() -> (PathBuf, Vec<String>) {
    if let Some(pwsh) = find_on_path("pwsh.exe") {
        return (pwsh, vec!["-NoLogo".into(), "-NoProfile".into()]);
    }
    let system_root = env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let powershell = Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    (powershell, vec!["-NoLogo".into(), "-NoProfile".into()])
}

#[cfg(not(windows))]
fn default_shell() -> (PathBuf, Vec<String>) {
    let shell = env::var_os("SHELL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    (shell, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_runtime_clears_an_outer_ccsm_wrapper_context() {
        let mut command = CommandBuilder::new("provider-fixture");
        for name in PROVIDER_RUNTIME_ENVIRONMENT {
            command.env(name, "outer-runtime");
        }

        clear_inherited_provider_runtime_environment(&mut command);

        for name in PROVIDER_RUNTIME_ENVIRONMENT {
            assert_eq!(command.get_env(name), None, "inherited {name}");
        }
    }

    #[test]
    fn thread_join_returns_at_the_shared_shutdown_deadline() {
        let mut handle = Some(thread::spawn(|| thread::sleep(Duration::from_millis(250))));
        let mut error = None;
        let started = Instant::now();

        join_thread_until(
            &mut handle,
            "fixture",
            started + Duration::from_millis(30),
            &mut error,
        );

        assert!(started.elapsed() < Duration::from_millis(150));
        assert!(handle.is_none());
        assert!(matches!(
            error,
            Some(BackendError::Platform(message)) if message.contains("shutdown deadline")
        ));
    }

    #[test]
    fn resize_queue_is_non_blocking_and_keeps_the_latest_size() {
        let pending = Mutex::new(None);
        let (tx, rx) = mpsc::sync_channel(1);

        queue_resize(&pending, &tx, 80, 24).unwrap();
        queue_resize(&pending, &tx, 140, 52).unwrap();

        assert!(matches!(rx.try_recv(), Ok(ResizeCommand::Wake)));
        assert_eq!(*pending.lock().unwrap(), Some((140, 52)));
    }

    #[test]
    fn runtime_shim_does_not_shadow_the_real_provider_name() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("ccsm-desktop.exe");
        std::fs::write(&source, b"shim").unwrap();
        let root = directory.path().join("runtime");
        std::fs::create_dir_all(&root).unwrap();
        let shim = RuntimeShim::create(&root, &source, "runtime-1", ProviderKind::Codex).unwrap();

        assert_eq!(
            shim.provider_executable
                .file_name()
                .unwrap()
                .to_string_lossy(),
            provider_shim_name()
        );
        assert!(!shim.directory.join(shim_name_for_test("codex")).exists());
        assert!(shim.hook_executable.exists());
    }

    #[test]
    fn copilot_runtime_shim_contains_an_isolated_hook_plugin() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("ccsm-desktop.exe");
        std::fs::write(&source, b"shim").unwrap();
        let root = directory.path().join("runtime");
        std::fs::create_dir_all(&root).unwrap();
        let shim = RuntimeShim::create(
            &root,
            &source,
            "4d753e91-dc8b-4b38-96a5-3770dc558acc",
            ProviderKind::Copilot,
        )
        .unwrap();

        let plugin = shim.copilot_plugin_dir().unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(plugin.join("plugin.json")).unwrap()).unwrap();
        let hooks: Value =
            serde_json::from_slice(&std::fs::read(plugin.join("hooks.json")).unwrap()).unwrap();
        assert_eq!(manifest["hooks"], "hooks.json");
        assert_eq!(
            manifest["name"],
            "ccsm-runtime-4d753e91-dc8b-4b38-96a5-3770dc558acc"
        );
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "Stop",
            "SessionEnd",
            "notification",
        ] {
            assert!(hooks["hooks"][event].is_array(), "missing {event}");
        }
        assert_eq!(
            hooks["hooks"]["notification"][0]["matcher"],
            "permission_prompt|elicitation_dialog"
        );
    }

    #[test]
    fn stale_runtime_shim_roots_are_scavenged_safely() {
        let parent = tempfile::tempdir().unwrap();
        let stale = parent
            .path()
            .join(format!("{RUNTIME_SHIM_ROOT_PREFIX}{}", u32::MAX));
        let active = parent
            .path()
            .join(format!("{RUNTIME_SHIM_ROOT_PREFIX}{}", std::process::id()));
        let unrelated = parent.path().join("ccsm-runtime-shims-not-a-pid");
        for directory in [&stale, &active, &unrelated] {
            std::fs::create_dir_all(directory.join("runtime-1")).unwrap();
            std::fs::write(directory.join("runtime-1/ccsm-provider.exe"), b"fixture").unwrap();
        }

        cleanup_stale_runtime_shim_roots(parent.path());

        assert!(!stale.exists());
        assert!(active.exists());
        assert!(unrelated.exists());
    }
}

#[cfg(all(test, windows))]
fn shim_name_for_test(stem: &str) -> String {
    format!("{stem}.exe")
}

#[cfg(all(test, not(windows)))]
fn shim_name_for_test(stem: &str) -> String {
    stem.into()
}
