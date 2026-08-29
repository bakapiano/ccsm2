use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
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
const MAX_TRANSCRIPT_METADATA_BYTES: u64 = 512 * 1024;
const MAX_AGENT_TITLE_CHARACTERS: usize = 96;
const CONNECT_RETRIES: usize = 40;

pub type HookReportSink = Arc<dyn Fn(HookReport) + Send + Sync + 'static>;

pub struct LocalHookEndpoint {
    address: String,
    stop: Arc<AtomicBool>,
    listener_thread: Mutex<Option<thread::JoinHandle<()>>>,
    consumer_thread: Mutex<Option<thread::JoinHandle<()>>>,
}

impl LocalHookEndpoint {
    pub fn start(sink: HookReportSink) -> BackendResult<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let address = endpoint_address();
        let (report_tx, report_rx) = mpsc::channel();
        let consumer = thread::Builder::new()
            .name("ccsm-hook-consumer".into())
            .spawn(move || consume_hook_reports(report_rx, sink))
            .map_err(|error| {
                BackendError::Platform(format!("start Hook consumer failed: {error}"))
            })?;
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_stop = Arc::clone(&stop);
        let worker_address = address.clone();
        let listener = match thread::Builder::new()
            .name("ccsm-hook-endpoint".into())
            .spawn(move || run_server(worker_address, worker_stop, report_tx, ready_tx))
        {
            Ok(listener) => listener,
            Err(error) => {
                let _ = consumer.join();
                return Err(BackendError::Platform(format!(
                    "start HookEndpoint failed: {error}"
                )));
            }
        };
        let ready = match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(ready) => ready,
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                let _ = write_endpoint(&address, &[]);
                let _ = listener.join();
                let _ = consumer.join();
                return Err(BackendError::Platform(
                    "HookEndpoint startup timed out".into(),
                ));
            }
        };
        if let Err(error) = ready {
            let _ = listener.join();
            let _ = consumer.join();
            return Err(error);
        }
        Ok(Self {
            address,
            stop,
            listener_thread: Mutex::new(Some(listener)),
            consumer_thread: Mutex::new(Some(consumer)),
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
        if let Ok(mut listener) = self.listener_thread.lock()
            && let Some(listener) = listener.take()
        {
            let _ = listener.join();
        }
        if let Ok(mut consumer) = self.consumer_thread.lock()
            && let Some(consumer) = consumer.take()
        {
            let _ = consumer.join();
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
    let identity = hook_payload_identity(&payload)?;
    Ok(HookReport {
        provider: parse_provider(&required_env("CCSM_PROVIDER")?)?,
        cli_session_id: required_env("CCSM_SESSION_ID")?,
        runtime_id: required_env("CCSM_RUNTIME_ID")?,
        token: required_env("CCSM_HOOK_TOKEN")?,
        native_session_id: identity.native_session_id,
        hook_event_name: identity.hook_event_name,
        transcript_path: identity.transcript_path,
        source: identity.source,
        parent_native_session_id: identity.parent_native_session_id,
        ephemeral: identity.ephemeral,
        display_title: hook_display_title(&payload),
    })
}

#[derive(Debug, PartialEq, Eq)]
struct HookPayloadIdentity {
    native_session_id: String,
    hook_event_name: String,
    transcript_path: Option<String>,
    source: Option<String>,
    parent_native_session_id: Option<String>,
    ephemeral: bool,
}

fn hook_payload_identity(payload: &Value) -> BackendResult<HookPayloadIdentity> {
    let native_session_id = payload_string(payload, &["session_id", "sessionId"])
        .ok_or_else(|| BackendError::Invalid("Hook payload has no session_id".into()))?;
    let hook_event_name = payload_string(payload, &["hook_event_name", "hookEventName"])
        .unwrap_or_else(|| "SessionStart".into());
    Ok(HookPayloadIdentity {
        native_session_id,
        hook_event_name,
        transcript_path: payload_string(payload, &["transcript_path", "transcriptPath"]),
        source: payload_string(payload, &["source"]),
        parent_native_session_id: payload_string(
            payload,
            &[
                "forked_from_id",
                "forkedFromId",
                "parent_session_id",
                "parentSessionId",
            ],
        ),
        ephemeral: payload_bool(payload, &["ephemeral", "is_sidechain", "isSidechain"])
            .unwrap_or(false),
    })
}

fn payload_string(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn payload_bool(payload: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_bool))
}

fn hook_display_title(payload: &Value) -> Option<String> {
    payload_string(payload, &["session_title", "sessionTitle"])
        .or_else(|| payload_string(payload, &["prompt", "initial_prompt", "initialPrompt"]))
        .and_then(|title| normalize_agent_title(&title))
}

fn normalize_agent_title(title: &str) -> Option<String> {
    let normalized = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty()
        || normalized.starts_with("<environment_context>")
        || normalized.starts_with("<permissions instructions>")
    {
        return None;
    }
    Some(if normalized.chars().count() > MAX_AGENT_TITLE_CHARACTERS {
        let shortened = normalized
            .chars()
            .take(MAX_AGENT_TITLE_CHARACTERS - 3)
            .collect::<String>();
        format!("{shortened}...")
    } else {
        normalized
    })
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

fn enqueue_message(bytes: Vec<u8>, queue: &mpsc::Sender<HookReport>) {
    if bytes.is_empty() || bytes.len() as u64 > MAX_HOOK_MESSAGE_BYTES {
        return;
    }
    if let Ok(report) = serde_json::from_slice::<HookReport>(&bytes) {
        let _ = queue.send(report);
    }
}

fn consume_hook_reports(queue: mpsc::Receiver<HookReport>, sink: HookReportSink) {
    for report in queue {
        sink(report);
    }
}

pub fn resolve_hook_display_title(report: &HookReport) -> Option<String> {
    if !matches!(report.provider, ProviderKind::Claude | ProviderKind::Codex) {
        return None;
    }
    let path = Path::new(report.transcript_path.as_deref()?);
    let file_name = path.file_name()?.to_string_lossy();
    if !file_name
        .to_ascii_lowercase()
        .contains(&report.native_session_id.to_ascii_lowercase())
    {
        return None;
    }
    if report.provider == ProviderKind::Codex
        && let Some(title) = codex_thread_name(path, &report.native_session_id)
    {
        return Some(title);
    }
    let chunks = read_bounded_jsonl_chunks(path).ok()?;
    transcript_title_from_chunks(report.provider, &chunks)
}

fn codex_thread_name(transcript_path: &Path, native_session_id: &str) -> Option<String> {
    let index_path = transcript_path
        .ancestors()
        .take(8)
        .map(|ancestor| ancestor.join("session_index.jsonl"))
        .find(|candidate| candidate.is_file())?;
    let chunks = read_bounded_jsonl_chunks(&index_path).ok()?;
    chunks
        .iter()
        .flat_map(|chunk| chunk.lines())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| payload_string(value, &["id"]).as_deref() == Some(native_session_id))
        .filter_map(|value| payload_string(&value, &["thread_name", "threadName"]))
        .filter_map(|title| normalize_agent_title(&title))
        .next_back()
}

fn transcript_title_from_chunks(provider: ProviderKind, chunks: &[String]) -> Option<String> {
    let values = chunks
        .iter()
        .flat_map(|chunk| chunk.lines())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let mut explicit_title = None;
    let mut summary = None;
    let mut latest_prompt = None;
    for value in &values {
        let kind = payload_string(value, &["type"]);
        if provider == ProviderKind::Claude {
            if matches!(kind.as_deref(), Some("custom-title" | "custom_title")) {
                explicit_title = payload_string(value, &["customTitle", "custom_title", "title"])
                    .and_then(|title| normalize_agent_title(&title));
            }
            if kind.as_deref() == Some("summary") {
                summary = payload_string(value, &["summary", "title"])
                    .and_then(|title| normalize_agent_title(&title));
            }
        }
        if let Some(prompt) = transcript_user_prompt(provider, value) {
            latest_prompt = normalize_agent_title(&prompt);
        }
    }
    explicit_title.or(summary).or(latest_prompt)
}

fn transcript_user_prompt(provider: ProviderKind, value: &Value) -> Option<String> {
    let payload = value.get("payload").unwrap_or(value);
    let message = payload.get("message").unwrap_or(payload);
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if provider == ProviderKind::Claude && value.get("type").and_then(Value::as_str) != Some("user")
    {
        return None;
    }
    message_content_text(message.get("content")?)
}

fn message_content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let text = content
        .as_array()?
        .iter()
        .filter(|part| {
            matches!(
                part.get("type").and_then(Value::as_str),
                Some("text" | "input_text")
            )
        })
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then_some(text)
}

fn read_bounded_jsonl_chunks(path: &Path) -> std::io::Result<Vec<String>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let half = MAX_TRANSCRIPT_METADATA_BYTES / 2;
    let prefix_length = length.min(half);
    let mut prefix = Vec::with_capacity(prefix_length as usize);
    Read::by_ref(&mut file)
        .take(prefix_length)
        .read_to_end(&mut prefix)?;
    let mut chunks = vec![String::from_utf8_lossy(&prefix).into_owned()];
    if length > MAX_TRANSCRIPT_METADATA_BYTES {
        file.seek(SeekFrom::Start(length - half))?;
        let mut suffix = Vec::with_capacity(half as usize);
        Read::by_ref(&mut file)
            .take(half)
            .read_to_end(&mut suffix)?;
        let suffix = String::from_utf8_lossy(&suffix);
        let complete_lines = suffix
            .find('\n')
            .map(|newline| &suffix[newline + 1..])
            .unwrap_or_default();
        chunks.push(complete_lines.to_string());
    }
    Ok(chunks)
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
#[derive(Debug, PartialEq, Eq)]
enum NamedPipeConnection {
    Connected,
    ConnectedBeforeWait,
    BufferedAfterClientClose,
}

#[cfg(windows)]
fn connect_named_pipe(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> std::io::Result<NamedPipeConnection> {
    use windows_sys::Win32::{
        Foundation::{ERROR_NO_DATA, ERROR_PIPE_CONNECTED},
        System::Pipes::ConnectNamedPipe,
    };

    if unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0 {
        return Ok(NamedPipeConnection::Connected);
    }

    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(code) if code == ERROR_PIPE_CONNECTED as i32 => {
            Ok(NamedPipeConnection::ConnectedBeforeWait)
        }
        // A client can write and close between CreateNamedPipeW and
        // ConnectNamedPipe. The payload remains buffered on this handle.
        Some(code) if code == ERROR_NO_DATA as i32 => {
            Ok(NamedPipeConnection::BufferedAfterClientClose)
        }
        _ => Err(error),
    }
}

#[cfg(windows)]
fn run_server(
    address: String,
    stop: Arc<AtomicBool>,
    queue: mpsc::Sender<HookReport>,
    ready: mpsc::Sender<BackendResult<()>>,
) {
    use std::{fs::File, os::windows::io::FromRawHandle};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::PIPE_ACCESS_INBOUND,
        System::Pipes::{CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE},
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
        if connect_named_pipe(handle).is_err() {
            unsafe { CloseHandle(handle) };
            if stop.load(Ordering::SeqCst) {
                return;
            }
            continue;
        }
        let mut file = unsafe { File::from_raw_handle(handle) };
        let mut bytes = Vec::new();
        let _ = Read::by_ref(&mut file)
            .take(MAX_HOOK_MESSAGE_BYTES + 1)
            .read_to_end(&mut bytes);
        drop(file);
        if !stop.load(Ordering::SeqCst) {
            enqueue_message(bytes, &queue);
        }
    }
}

#[cfg(unix)]
fn run_server(
    address: String,
    stop: Arc<AtomicBool>,
    queue: mpsc::Sender<HookReport>,
    ready: mpsc::Sender<BackendResult<()>>,
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
            enqueue_message(bytes, &queue);
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
    use std::sync::{Condvar, mpsc};

    use super::*;

    #[test]
    fn hook_payload_accepts_copilot_camel_case_session_identity() {
        let identity = hook_payload_identity(&serde_json::json!({
            "sessionId": "copilot-session",
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt"
        }))
        .unwrap();
        assert_eq!(identity.native_session_id, "copilot-session");
        assert_eq!(identity.hook_event_name, "Notification");
    }

    #[test]
    fn hook_payload_normalizes_provider_ephemeral_child_metadata() {
        for (payload, expected_parent) in [
            (
                serde_json::json!({
                    "session_id": "codex-side",
                    "hook_event_name": "SessionStart",
                    "forked_from_id": "codex-parent",
                    "ephemeral": true
                }),
                "codex-parent",
            ),
            (
                serde_json::json!({
                    "session_id": "claude-side",
                    "hook_event_name": "SessionStart",
                    "parent_session_id": "claude-parent",
                    "is_sidechain": true
                }),
                "claude-parent",
            ),
            (
                serde_json::json!({
                    "sessionId": "copilot-side",
                    "hookEventName": "SessionStart",
                    "parentSessionId": "copilot-parent",
                    "ephemeral": true
                }),
                "copilot-parent",
            ),
        ] {
            let identity = hook_payload_identity(&payload).unwrap();
            assert_eq!(
                identity.parent_native_session_id.as_deref(),
                Some(expected_parent)
            );
            assert!(identity.ephemeral);
        }
    }

    #[test]
    fn hook_payload_preserves_session_start_context() {
        let identity = hook_payload_identity(&serde_json::json!({
            "session_id": "codex-session",
            "hook_event_name": "SessionStart",
            "transcript_path": "C:/runtime/rollout.jsonl",
            "source": "clear"
        }))
        .unwrap();
        assert_eq!(identity.source.as_deref(), Some("clear"));
        assert_eq!(
            identity.transcript_path.as_deref(),
            Some("C:/runtime/rollout.jsonl")
        );
    }

    #[test]
    fn hook_title_prefers_native_session_title_and_normalizes_prompt_fallback() {
        assert_eq!(
            hook_display_title(&serde_json::json!({
                "session_title": "  Fix   authentication  ",
                "prompt": "fallback prompt"
            }))
            .as_deref(),
            Some("Fix authentication")
        );
        assert_eq!(
            hook_display_title(&serde_json::json!({
                "prompt": "Investigate\nrenderer latency"
            }))
            .as_deref(),
            Some("Investigate renderer latency")
        );
    }

    #[test]
    fn claude_transcript_prefers_custom_title_over_summary_and_prompt() {
        let directory = tempfile::tempdir().unwrap();
        let native_session_id = "11111111-1111-1111-1111-111111111111";
        let transcript = directory.path().join(format!("{native_session_id}.jsonl"));
        std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"user","message":{"role":"user","content":"first prompt"}}"#,
                "\n",
                r#"{"type":"summary","summary":"Generated session summary"}"#,
                "\n",
                r#"{"type":"custom-title","customTitle":"Fix auth flow"}"#,
                "\n"
            ),
        )
        .unwrap();
        let report = HookReport {
            provider: ProviderKind::Claude,
            cli_session_id: "cli-session".into(),
            runtime_id: "runtime".into(),
            token: "token".into(),
            native_session_id: native_session_id.into(),
            hook_event_name: "SessionStart".into(),
            transcript_path: Some(transcript.to_string_lossy().into_owned()),
            source: Some("resume".into()),
            parent_native_session_id: None,
            ephemeral: false,
            display_title: None,
        };

        assert_eq!(
            resolve_hook_display_title(&report).as_deref(),
            Some("Fix auth flow")
        );
    }

    #[test]
    fn codex_transcript_uses_the_authenticated_thread_name_index() {
        let directory = tempfile::tempdir().unwrap();
        let native_session_id = "22222222-2222-2222-2222-222222222222";
        let sessions = directory.path().join("sessions").join("2026").join("08");
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = sessions.join(format!("rollout-{native_session_id}.jsonl"));
        std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fallback prompt"}]}}"#,
                "\n"
            ),
        )
        .unwrap();
        std::fs::write(
            directory.path().join("session_index.jsonl"),
            format!(
                "{{\"id\":\"{native_session_id}\",\"thread_name\":\"Renderer recovery\",\"updated_at\":\"2026-08-29T00:00:00Z\"}}\n"
            ),
        )
        .unwrap();
        let report = HookReport {
            provider: ProviderKind::Codex,
            cli_session_id: "cli-session".into(),
            runtime_id: "runtime".into(),
            token: "token".into(),
            native_session_id: native_session_id.into(),
            hook_event_name: "SessionStart".into(),
            transcript_path: Some(transcript.to_string_lossy().into_owned()),
            source: Some("resume".into()),
            parent_native_session_id: None,
            ephemeral: false,
            display_title: None,
        };

        assert_eq!(
            resolve_hook_display_title(&report).as_deref(),
            Some("Renderer recovery")
        );
    }

    #[test]
    fn strict_reporter_propagates_delivery_failures() {
        assert_eq!(hook_reporter_exit_code(true, true), 1);
        assert_eq!(hook_reporter_exit_code(false, true), 0);
        assert_eq!(hook_reporter_exit_code(true, false), 0);
    }

    #[test]
    fn endpoint_delivers_a_complete_report() {
        let (tx, rx) = mpsc::channel();
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
            transcript_path: Some("rollout.jsonl".into()),
            source: Some("startup".into()),
            parent_native_session_id: None,
            ephemeral: false,
            display_title: None,
        };
        write_endpoint(
            endpoint.address(),
            &serde_json::to_vec(&report).expect("serialize report"),
        )
        .expect("send report");
        let received = rx
            .recv_timeout(Duration::from_secs(30))
            .expect("receive report");
        assert_eq!(received.runtime_id, report.runtime_id);
        assert_eq!(received.native_session_id, report.native_session_id);
        endpoint.shutdown();
    }

    #[test]
    fn endpoint_accepts_reports_while_the_consumer_is_busy() {
        let (consumer_started_tx, consumer_started_rx) = mpsc::channel();
        let release_consumer = Arc::new((Mutex::new(false), Condvar::new()));
        let consumer_release = Arc::clone(&release_consumer);
        let (delivered_tx, delivered_rx) = mpsc::channel();
        let endpoint = LocalHookEndpoint::start(Arc::new(move |report| {
            delivered_tx
                .send(report.native_session_id.clone())
                .expect("record delivered report");
            if report.native_session_id == "native-slow" {
                consumer_started_tx.send(()).expect("signal slow consumer");
                let (released, wake) = &*consumer_release;
                let mut released = released.lock().expect("lock consumer release");
                while !*released {
                    released = wake.wait(released).expect("wait for consumer release");
                }
            }
        }))
        .expect("start endpoint");
        let report = |native_session_id: &str| HookReport {
            provider: ProviderKind::Codex,
            cli_session_id: "session-queue".into(),
            runtime_id: "runtime-queue".into(),
            token: "secret".into(),
            native_session_id: native_session_id.into(),
            hook_event_name: "SessionStart".into(),
            transcript_path: None,
            source: Some("startup".into()),
            parent_native_session_id: None,
            ephemeral: false,
            display_title: None,
        };

        write_endpoint(
            endpoint.address(),
            &serde_json::to_vec(&report("native-slow")).expect("serialize slow report"),
        )
        .expect("send slow report");
        consumer_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("slow consumer starts");

        let second_address = endpoint.address().to_owned();
        let second_payload =
            serde_json::to_vec(&report("native-fast")).expect("serialize queued report");
        let (write_finished_tx, write_finished_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            let _ = write_finished_tx.send(write_endpoint(&second_address, &second_payload));
        });
        let second_result = write_finished_rx.recv_timeout(Duration::from_secs(3));

        let (released, wake) = &*release_consumer;
        *released.lock().expect("lock consumer release") = true;
        wake.notify_all();
        writer.join().expect("join queued report writer");

        second_result
            .expect("queued report completes while consumer is busy")
            .expect("send queued report");
        assert_eq!(
            delivered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("receive slow report"),
            "native-slow"
        );
        assert_eq!(
            delivered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("receive queued report"),
            "native-fast"
        );
        endpoint.shutdown();
    }

    #[cfg(windows)]
    #[test]
    fn endpoint_delivers_report_closed_before_connect_wait() {
        use std::{
            fs::File,
            os::windows::io::{AsRawHandle, FromRawHandle},
        };

        use windows_sys::Win32::{
            Foundation::INVALID_HANDLE_VALUE,
            Storage::FileSystem::PIPE_ACCESS_INBOUND,
            System::Pipes::{CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE},
        };

        let address = endpoint_address();
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
        assert_ne!(handle, INVALID_HANDLE_VALUE, "create test named pipe");
        let mut pipe = unsafe { File::from_raw_handle(handle) };

        let report = HookReport {
            provider: ProviderKind::Codex,
            cli_session_id: "session-before-connect".into(),
            runtime_id: "runtime-before-connect".into(),
            token: "secret".into(),
            native_session_id: "native-before-connect".into(),
            hook_event_name: "SessionStart".into(),
            transcript_path: Some("rollout-before-connect.jsonl".into()),
            source: Some("startup".into()),
            parent_native_session_id: None,
            ephemeral: false,
            display_title: None,
        };
        let payload = serde_json::to_vec(&report).expect("serialize report");
        let client_address = address.clone();
        let client = thread::spawn(move || write_endpoint(&client_address, &payload));
        client
            .join()
            .expect("join named-pipe client")
            .expect("write report before ConnectNamedPipe");

        let connection = connect_named_pipe(pipe.as_raw_handle());
        assert_eq!(
            connection.expect("accept buffered named-pipe report"),
            NamedPipeConnection::BufferedAfterClientClose
        );

        let mut bytes = Vec::new();
        Read::by_ref(&mut pipe)
            .take(MAX_HOOK_MESSAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .expect("read buffered named-pipe report");

        let (tx, rx) = mpsc::channel();
        enqueue_message(bytes, &tx);
        let received = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("deliver buffered named-pipe report");
        assert_eq!(received.runtime_id, report.runtime_id);
        assert_eq!(received.native_session_id, report.native_session_id);
    }
}
