use std::{
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use ccsm_core::{
    dto::{HookReport, ProviderKind},
    error::{BackendError, BackendResult},
};
use serde_json::Value;
use uuid::Uuid;

const MAX_HOOK_MESSAGE_BYTES: u64 = 1024 * 1024;
const CONNECT_RETRIES: usize = 40;

pub type HookReportSink = Arc<dyn Fn(HookReport) + Send + Sync + 'static>;

pub struct LocalHookEndpoint {
    address: String,
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

impl LocalHookEndpoint {
    pub fn start(sink: HookReportSink) -> BackendResult<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let address = endpoint_address();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker_stop = Arc::clone(&stop);
        let worker_address = address.clone();
        let worker = thread::Builder::new()
            .name("ccsm-hook-endpoint".into())
            .spawn(move || run_server(worker_address, worker_stop, sink, ready_tx))
            .map_err(|error| {
                BackendError::Platform(format!("start HookEndpoint failed: {error}"))
            })?;
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| BackendError::Platform("HookEndpoint startup timed out".into()))??;
        Ok(Self {
            address,
            stop,
            thread: Mutex::new(Some(worker)),
        })
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub fn shutdown(&self) {
        if self.stop.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = write_endpoint(&self.address, &[]);
        if let Ok(mut worker) = self.thread.lock()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.address);
        }
    }
}

impl Drop for LocalHookEndpoint {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn run_hook_reporter() -> i32 {
    let result = collect_hook_report().and_then(|report| {
        let endpoint = required_env("CCSM_HOOK_PIPE")?;
        let payload = serde_json::to_vec(&report)
            .map_err(|error| BackendError::Platform(error.to_string()))?;
        write_endpoint(&endpoint, &payload)
            .map_err(|error| BackendError::Platform(format!("send Hook report: {error}")))
    });
    let _ = std::io::stdout().write_all(b"{}\n");
    let failed = result.is_err();
    if let Err(error) = result {
        eprintln!("ccsm hook report skipped: {error}");
    }
    hook_reporter_exit_code(
        failed,
        std::env::var("CCSM_HOOK_REPORTER_STRICT").as_deref() == Ok("1"),
    )
}

fn hook_reporter_exit_code(failed: bool, strict: bool) -> i32 {
    i32::from(failed && strict)
}

fn collect_hook_report() -> BackendResult<HookReport> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_HOOK_MESSAGE_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|error| BackendError::Invalid(format!("read Hook stdin: {error}")))?;
    if input.len() as u64 > MAX_HOOK_MESSAGE_BYTES {
        return Err(BackendError::Invalid("Hook payload is too large".into()));
    }
    let payload: Value = serde_json::from_slice(&input)
        .map_err(|error| BackendError::Invalid(format!("parse Hook payload: {error}")))?;
    let (native_session_id, hook_event_name) = hook_payload_identity(&payload)?;
    Ok(HookReport {
        provider: parse_provider(&required_env("CCSM_PROVIDER")?)?,
        cli_session_id: required_env("CCSM_SESSION_ID")?,
        runtime_id: required_env("CCSM_RUNTIME_ID")?,
        token: required_env("CCSM_HOOK_TOKEN")?,
        native_session_id,
        hook_event_name,
    })
}

fn hook_payload_identity(payload: &Value) -> BackendResult<(String, String)> {
    let native_session_id = payload
        .get("session_id")
        .or_else(|| payload.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| BackendError::Invalid("Hook payload has no session_id".into()))?;
    let hook_event_name = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or("SessionStart");
    Ok((native_session_id.to_string(), hook_event_name.to_string()))
}

fn required_env(name: &str) -> BackendResult<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BackendError::Invalid(format!("missing {name}")))
}

fn parse_provider(value: &str) -> BackendResult<ProviderKind> {
    match value {
        "claude" => Ok(ProviderKind::Claude),
        "codex" => Ok(ProviderKind::Codex),
        "copilot" => Ok(ProviderKind::Copilot),
        _ => Err(BackendError::Invalid(format!(
            "unsupported Hook provider {value}"
        ))),
    }
}

fn handle_message(bytes: Vec<u8>, sink: &HookReportSink) {
    if bytes.is_empty() || bytes.len() as u64 > MAX_HOOK_MESSAGE_BYTES {
        return;
    }
    if let Ok(report) = serde_json::from_slice::<HookReport>(&bytes) {
        sink(report);
    }
}

#[cfg(windows)]
fn endpoint_address() -> String {
    format!(
        r"\\.\pipe\ccsm-hooks-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    )
}

#[cfg(unix)]
fn endpoint_address() -> String {
    std::env::temp_dir()
        .join(format!(
            "ccsm-hooks-{}-{}.sock",
            std::process::id(),
            &Uuid::new_v4().simple().to_string()[..12]
        ))
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn run_server(
    address: String,
    stop: Arc<AtomicBool>,
    sink: HookReportSink,
    ready: mpsc::SyncSender<BackendResult<()>>,
) {
    use std::{fs::File, os::windows::io::FromRawHandle};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
        Storage::FileSystem::PIPE_ACCESS_INBOUND,
        System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE},
    };

    let mut first = true;
    while !stop.load(Ordering::SeqCst) {
        let wide = address
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_INBOUND,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE,
                1,
                0,
                MAX_HOOK_MESSAGE_BYTES as u32,
                500,
                std::ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = BackendError::Platform(format!(
                "create Hook named pipe: {}",
                std::io::Error::last_os_error()
            ));
            if first {
                let _ = ready.send(Err(error));
            }
            return;
        }
        if first {
            first = false;
            let _ = ready.send(Ok(()));
        }
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
        if connected == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
                unsafe { CloseHandle(handle) };
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                continue;
            }
        }
        let mut file = unsafe { File::from_raw_handle(handle) };
        let mut bytes = Vec::new();
        let _ = Read::by_ref(&mut file)
            .take(MAX_HOOK_MESSAGE_BYTES + 1)
            .read_to_end(&mut bytes);
        drop(file);
        if !stop.load(Ordering::SeqCst) {
            handle_message(bytes, &sink);
        }
    }
}

#[cfg(unix)]
fn run_server(
    address: String,
    stop: Arc<AtomicBool>,
    sink: HookReportSink,
    ready: mpsc::SyncSender<BackendResult<()>>,
) {
    use std::os::unix::net::UnixListener;

    let _ = std::fs::remove_file(&address);
    let listener = match UnixListener::bind(&address) {
        Ok(listener) => listener,
        Err(error) => {
            let _ = ready.send(Err(BackendError::Platform(format!(
                "bind Hook socket: {error}"
            ))));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    while !stop.load(Ordering::SeqCst) {
        let Ok((mut stream, _)) = listener.accept() else {
            continue;
        };
        let mut bytes = Vec::new();
        let _ = Read::by_ref(&mut stream)
            .take(MAX_HOOK_MESSAGE_BYTES + 1)
            .read_to_end(&mut bytes);
        if !stop.load(Ordering::SeqCst) {
            handle_message(bytes, &sink);
        }
    }
}

#[cfg(windows)]
fn write_endpoint(address: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::fs::OpenOptions;

    let mut last_error = None;
    for _ in 0..CONNECT_RETRIES {
        match OpenOptions::new().write(true).open(address) {
            Ok(mut pipe) => {
                pipe.write_all(bytes)?;
                pipe.flush()?;
                return Ok(());
            }
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(25));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("Hook pipe unavailable")))
}

#[cfg(unix)]
fn write_endpoint(address: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::{net::Shutdown, os::unix::net::UnixStream};

    let mut last_error = None;
    for _ in 0..CONNECT_RETRIES {
        match UnixStream::connect(address) {
            Ok(mut stream) => {
                stream.write_all(bytes)?;
                stream.shutdown(Shutdown::Write)?;
                return Ok(());
            }
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(25));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("Hook socket unavailable")))
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn hook_payload_accepts_copilot_camel_case_session_identity() {
        let (session_id, event) = hook_payload_identity(&serde_json::json!({
            "sessionId": "copilot-session",
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt"
        }))
        .unwrap();
        assert_eq!(session_id, "copilot-session");
        assert_eq!(event, "Notification");
    }

    #[test]
    fn strict_reporter_propagates_delivery_failures() {
        assert_eq!(hook_reporter_exit_code(true, true), 1);
        assert_eq!(hook_reporter_exit_code(false, true), 0);
        assert_eq!(hook_reporter_exit_code(true, false), 0);
    }

    #[test]
    fn endpoint_delivers_a_complete_report() {
        let (tx, rx) = mpsc::sync_channel(1);
        let endpoint = LocalHookEndpoint::start(Arc::new(move |report| {
            let _ = tx.send(report);
        }))
        .expect("start endpoint");
        let report = HookReport {
            provider: ProviderKind::Codex,
            cli_session_id: "session-1".into(),
            runtime_id: "runtime-1".into(),
            token: "secret".into(),
            native_session_id: "native-1".into(),
            hook_event_name: "SessionStart".into(),
        };
        write_endpoint(
            endpoint.address(),
            &serde_json::to_vec(&report).expect("serialize report"),
        )
        .expect("send report");
        let received = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("receive report");
        assert_eq!(received.runtime_id, report.runtime_id);
        assert_eq!(received.native_session_id, report.native_session_id);
        endpoint.shutdown();
    }
}
