use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, Weak},
    thread,
    time::Duration,
};

use crossbeam_channel::{Receiver, RecvTimeoutError};
use uuid::Uuid;

use crate::{
    dto::{
        AgentActivity, CliSessionDto, HookReport, NativeBindingState, ProviderKind, RuntimeEvent,
        RuntimeStartedDto,
    },
    error::{BackendError, BackendResult},
    ports::{PtyBackend, PtyEvent, PtyEventSink, PtyHookContext, PtyProcess, PtySpawnSpec},
};

pub type RuntimeEventSink = Arc<dyn Fn(RuntimeEvent) + Send + Sync + 'static>;

const RUNTIME_EVENT_QUEUE_CAPACITY: usize = 64;
const RUNTIME_OUTPUT_CREDIT_BYTES: usize = 512 * 1024;
const RUNTIME_OUTPUT_BATCH_BYTES: usize = 8 * 1024;
const RUNTIME_OUTPUT_COALESCE_WAIT: Duration = Duration::from_millis(1);

#[derive(Debug, Default)]
struct OutputFlowState {
    in_flight_bytes: usize,
    closed: bool,
}

#[derive(Debug)]
struct OutputFlow {
    state: Mutex<OutputFlowState>,
    changed: Condvar,
    capacity_bytes: usize,
}

impl OutputFlow {
    fn new(capacity_bytes: usize) -> Self {
        Self {
            state: Mutex::new(OutputFlowState::default()),
            changed: Condvar::new(),
            capacity_bytes,
        }
    }

    fn reserve(&self, bytes: usize) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        while !state.closed
            && state.in_flight_bytes > 0
            && state.in_flight_bytes.saturating_add(bytes) > self.capacity_bytes
        {
            let Ok(next) = self.changed.wait(state) else {
                return false;
            };
            state = next;
        }
        if state.closed {
            return false;
        }
        state.in_flight_bytes = state.in_flight_bytes.saturating_add(bytes);
        true
    }

    fn acknowledge(&self, bytes: usize) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.in_flight_bytes = state.in_flight_bytes.saturating_sub(bytes);
        self.changed.notify_all();
    }

    fn reset(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.in_flight_bytes = 0;
        state.closed = false;
        self.changed.notify_all();
    }

    fn close(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.closed = true;
        state.in_flight_bytes = 0;
        self.changed.notify_all();
    }

    #[cfg(test)]
    fn in_flight_bytes(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.in_flight_bytes)
            .unwrap_or_default()
    }
}

fn run_runtime_events(
    receiver: Receiver<PtyEvent>,
    output_flow: Arc<OutputFlow>,
    manager: Weak<RuntimeManager>,
    cli_session_id: String,
    runtime_id: String,
    sink: Arc<Mutex<RuntimeEventSink>>,
) {
    let mut pending = None;
    let mut disconnected = false;
    loop {
        let event = match pending.take() {
            Some(event) => event,
            None => match receiver.recv() {
                Ok(event) => event,
                Err(_) => break,
            },
        };
        let event = match event {
            PtyEvent::Output(mut data) => {
                while data.len() < RUNTIME_OUTPUT_BATCH_BYTES {
                    match receiver.recv_timeout(RUNTIME_OUTPUT_COALESCE_WAIT) {
                        Ok(PtyEvent::Output(next))
                            if data.len().saturating_add(next.len())
                                <= RUNTIME_OUTPUT_BATCH_BYTES =>
                        {
                            data.extend_from_slice(&next);
                        }
                        Ok(next) => {
                            pending = Some(next);
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            disconnected = true;
                            break;
                        }
                    }
                }
                PtyEvent::Output(data)
            }
            event => event,
        };
        let is_exit = matches!(event, PtyEvent::Exit(_));
        let runtime_event = match event {
            PtyEvent::Output(data) => {
                if !output_flow.reserve(data.len()) {
                    if disconnected && pending.is_none() {
                        break;
                    }
                    continue;
                }
                RuntimeEvent::Output {
                    runtime_id: runtime_id.clone(),
                    data,
                }
            }
            PtyEvent::Error(message) => RuntimeEvent::Error {
                runtime_id: runtime_id.clone(),
                message,
            },
            PtyEvent::Exit(code) => {
                output_flow.close();
                if let Some(manager) = Weak::upgrade(&manager) {
                    manager.remove_if_current(&cli_session_id, &runtime_id);
                }
                RuntimeEvent::Exit {
                    runtime_id: runtime_id.clone(),
                    code,
                }
            }
        };
        let current_sink = sink.lock().ok().map(|sink| Arc::clone(&sink));
        if let Some(current_sink) = current_sink {
            current_sink(runtime_event);
        }
        if is_exit || (disconnected && pending.is_none()) {
            break;
        }
    }
}

struct RuntimeEntry {
    cli_session_id: String,
    provider: ProviderKind,
    process: Arc<dyn PtyProcess>,
    sink: Arc<Mutex<RuntimeEventSink>>,
    output_flow: Arc<OutputFlow>,
}

struct HookRegistration {
    cli_session_id: String,
    provider: ProviderKind,
    token: String,
    activity: AgentActivity,
    turn_active: bool,
}

#[derive(Default)]
struct RuntimeState {
    entries: HashMap<String, RuntimeEntry>,
    session_runtime: HashMap<String, String>,
    hook_registrations: HashMap<String, HookRegistration>,
}

#[derive(Debug, Clone)]
pub struct HookTransportDescriptor {
    pub endpoint: String,
    pub reporter_path: String,
}

#[derive(Debug, Clone)]
pub struct ValidatedHookBinding {
    pub cli_session_id: String,
    pub provider: ProviderKind,
    pub native_session_id: String,
}

#[derive(Debug, Clone)]
pub struct ValidatedHookReport {
    pub binding: ValidatedHookBinding,
    pub activity: AgentActivity,
}

pub struct RuntimeManager {
    backend: Arc<dyn PtyBackend>,
    state: Mutex<RuntimeState>,
}

impl RuntimeManager {
    pub fn new(backend: Arc<dyn PtyBackend>) -> Arc<Self> {
        Arc::new(Self {
            backend,
            state: Mutex::new(RuntimeState::default()),
        })
    }

    pub fn start_session(
        self: &Arc<Self>,
        session: CliSessionDto,
        cols: u16,
        rows: u16,
        hook_transport: Option<HookTransportDescriptor>,
        sink: RuntimeEventSink,
    ) -> BackendResult<RuntimeStartedDto> {
        {
            let state = self.lock_state()?;
            if let Some(runtime_id) = state.session_runtime.get(&session.id) {
                let entry = state.entries.get(runtime_id).ok_or_else(|| {
                    BackendError::Conflict(format!(
                        "CLI session {} runtime is still starting",
                        session.id
                    ))
                })?;
                *entry
                    .sink
                    .lock()
                    .map_err(|_| BackendError::Platform("runtime sink lock poisoned".into()))? =
                    sink;
                entry.output_flow.reset();
                return Ok(runtime_started(
                    runtime_id,
                    entry,
                    session.native_binding_state,
                ));
            }
        }

        let runtime_id = Uuid::new_v4().to_string();
        let hook = if session.provider == ProviderKind::Shell {
            None
        } else {
            let transport = hook_transport.ok_or_else(|| {
                BackendError::Platform("CLI HookEndpoint is not configured".into())
            })?;
            let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            self.lock_state()?.hook_registrations.insert(
                runtime_id.clone(),
                HookRegistration {
                    cli_session_id: session.id.clone(),
                    provider: session.provider,
                    token: token.clone(),
                    activity: AgentActivity::Starting,
                    turn_active: false,
                },
            );
            Some(PtyHookContext {
                cli_session_id: session.id.clone(),
                runtime_id: runtime_id.clone(),
                endpoint: transport.endpoint,
                token,
                reporter_path: transport.reporter_path,
            })
        };
        {
            let mut state = self.lock_state()?;
            state
                .session_runtime
                .insert(session.id.clone(), runtime_id.clone());
        }

        let sink = Arc::new(Mutex::new(sink));
        let output_flow = Arc::new(OutputFlow::new(RUNTIME_OUTPUT_CREDIT_BYTES));
        let (pty_event_tx, pty_event_rx) = crossbeam_channel::bounded(RUNTIME_EVENT_QUEUE_CAPACITY);
        let queued_event_sink: PtyEventSink = Arc::new(move |event| {
            let _ = pty_event_tx.send(event);
        });

        let process = match self.backend.spawn(
            PtySpawnSpec {
                cwd: session.cwd.clone(),
                cols,
                rows,
                provider: session.provider,
                native_session_id: session.native_session_id.clone(),
                hook,
            },
            queued_event_sink,
        ) {
            Ok(process) => process,
            Err(error) => {
                self.remove_if_current(&session.id, &runtime_id);
                return Err(error);
            }
        };

        // Codex and Copilot create their native sessions lazily on the first prompt, so
        // SessionStart cannot mark an untouched prompt as ready. Process spawn
        // is sufficient for activity only; native binding remains Hook-only.
        if matches!(
            session.provider,
            ProviderKind::Codex | ProviderKind::Copilot
        ) {
            let mut state = self.lock_state()?;
            if let Some(registration) = state.hook_registrations.get_mut(&runtime_id)
                && registration.activity == AgentActivity::Starting
            {
                registration.activity = AgentActivity::Idle;
            }
        }

        let started = {
            let mut state = self.lock_state()?;
            state.entries.insert(
                runtime_id.clone(),
                RuntimeEntry {
                    cli_session_id: session.id,
                    provider: session.provider,
                    process: Arc::clone(&process),
                    sink: Arc::clone(&sink),
                    output_flow: Arc::clone(&output_flow),
                },
            );
            let entry = state
                .entries
                .get(&runtime_id)
                .ok_or_else(|| BackendError::NotFound(format!("runtime {runtime_id}")))?;
            runtime_started(&runtime_id, entry, session.native_binding_state)
        };

        let weak = Arc::downgrade(self);
        let event_session_id = started.cli_session_id.clone();
        let event_runtime_id = runtime_id.clone();
        let dispatch_result = thread::Builder::new()
            .name("ccsm-runtime-events".into())
            .spawn(move || {
                run_runtime_events(
                    pty_event_rx,
                    output_flow,
                    weak,
                    event_session_id,
                    event_runtime_id,
                    sink,
                )
            });
        if let Err(error) = dispatch_result {
            self.remove_if_current(&started.cli_session_id, &runtime_id);
            let _ = process.stop();
            return Err(BackendError::Platform(format!(
                "start runtime event dispatcher failed: {error}"
            )));
        }

        Ok(started)
    }

    pub fn apply_hook_report(&self, report: &HookReport) -> BackendResult<ValidatedHookReport> {
        if !matches!(
            report.hook_event_name.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "PermissionRequest"
                | "PreToolUse"
                | "Notification"
                | "Stop"
                | "StopFailure"
                | "SessionEnd"
        ) {
            return Err(BackendError::Invalid(format!(
                "unsupported Hook event {}",
                report.hook_event_name
            )));
        }
        if report.native_session_id.trim().is_empty() || report.native_session_id.len() > 512 {
            return Err(BackendError::Invalid(
                "Hook native Session ID is invalid".into(),
            ));
        }
        let mut state = self.lock_state()?;
        let registration = state
            .hook_registrations
            .get_mut(&report.runtime_id)
            .ok_or_else(|| BackendError::Conflict("Hook runtime is no longer active".into()))?;
        if registration.cli_session_id != report.cli_session_id
            || registration.provider != report.provider
            || !tokens_equal(&registration.token, &report.token)
        {
            return Err(BackendError::Conflict(
                "Hook authentication context does not match the runtime".into(),
            ));
        }
        let (activity, turn_active) = reduce_agent_activity(
            registration.activity,
            registration.turn_active,
            &report.hook_event_name,
        );
        registration.activity = activity;
        registration.turn_active = turn_active;
        Ok(ValidatedHookReport {
            binding: ValidatedHookBinding {
                cli_session_id: registration.cli_session_id.clone(),
                provider: registration.provider,
                native_session_id: report.native_session_id.clone(),
            },
            activity,
        })
    }

    pub fn agent_activity(
        &self,
        cli_session_id: &str,
    ) -> BackendResult<Option<(String, AgentActivity)>> {
        let state = self.lock_state()?;
        let Some(runtime_id) = state.session_runtime.get(cli_session_id) else {
            return Ok(None);
        };
        Ok(state
            .hook_registrations
            .get(runtime_id)
            .map(|registration| (runtime_id.clone(), registration.activity)))
    }

    pub fn has_session(&self, cli_session_id: &str) -> BackendResult<bool> {
        Ok(self
            .lock_state()?
            .session_runtime
            .contains_key(cli_session_id))
    }

    pub fn write(&self, runtime_id: &str, data: Vec<u8>) -> BackendResult<()> {
        self.process(runtime_id)?.write(data)
    }

    pub fn resize(&self, runtime_id: &str, cols: u16, rows: u16) -> BackendResult<()> {
        self.process(runtime_id)?.resize(cols.max(2), rows.max(1))
    }

    pub fn acknowledge_output(&self, runtime_id: &str, bytes: usize) -> BackendResult<()> {
        let state = self.lock_state()?;
        let entry = state
            .entries
            .get(runtime_id)
            .ok_or_else(|| BackendError::NotFound(format!("runtime {runtime_id}")))?;
        entry.output_flow.acknowledge(bytes);
        Ok(())
    }

    pub fn stop(&self, runtime_id: &str) -> BackendResult<String> {
        let state = self.lock_state()?;
        let entry = state
            .entries
            .get(runtime_id)
            .ok_or_else(|| BackendError::NotFound(format!("runtime {runtime_id}")))?;
        entry.output_flow.close();
        entry.process.stop()?;
        Ok(entry.cli_session_id.clone())
    }

    pub fn stop_session(&self, cli_session_id: &str) -> BackendResult<()> {
        let process = {
            let state = self.lock_state()?;
            let Some(runtime_id) = state.session_runtime.get(cli_session_id) else {
                return Ok(());
            };
            state.entries.get(runtime_id).map(|entry| {
                entry.output_flow.close();
                Arc::clone(&entry.process)
            })
        };
        if let Some(process) = process {
            process.stop()?;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        let processes = match self.lock_state() {
            Ok(mut state) => {
                let processes = state
                    .entries
                    .values()
                    .map(|entry| {
                        entry.output_flow.close();
                        Arc::clone(&entry.process)
                    })
                    .collect::<Vec<_>>();
                state.entries.clear();
                state.session_runtime.clear();
                state.hook_registrations.clear();
                processes
            }
            Err(_) => return,
        };
        for process in processes {
            let _ = process.shutdown();
        }
    }

    fn process(&self, runtime_id: &str) -> BackendResult<Arc<dyn PtyProcess>> {
        self.lock_state()?
            .entries
            .get(runtime_id)
            .map(|entry| Arc::clone(&entry.process))
            .ok_or_else(|| BackendError::NotFound(format!("runtime {runtime_id}")))
    }

    fn remove_if_current(&self, session_id: &str, runtime_id: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state
            .session_runtime
            .get(session_id)
            .is_some_and(|current| current == runtime_id)
        {
            state.session_runtime.remove(session_id);
        }
        state.entries.remove(runtime_id);
        state.hook_registrations.remove(runtime_id);
    }

    fn lock_state(&self) -> BackendResult<std::sync::MutexGuard<'_, RuntimeState>> {
        self.state
            .lock()
            .map_err(|_| BackendError::Platform("runtime state lock poisoned".into()))
    }
}

fn reduce_agent_activity(
    current: AgentActivity,
    turn_active: bool,
    event: &str,
) -> (AgentActivity, bool) {
    match event {
        "SessionStart" if !turn_active => (AgentActivity::Idle, false),
        "SessionStart" => (current, turn_active),
        "UserPromptSubmit" => (AgentActivity::Working, true),
        "PermissionRequest" if turn_active => (AgentActivity::Blocked, true),
        "Notification" if turn_active => (AgentActivity::Blocked, true),
        "PreToolUse" if turn_active => (AgentActivity::Working, true),
        "PermissionRequest" | "PreToolUse" | "Notification" => (current, turn_active),
        "Stop" | "StopFailure" => (AgentActivity::Idle, false),
        _ => (current, turn_active),
    }
}

fn runtime_started(
    runtime_id: &str,
    entry: &RuntimeEntry,
    native_binding_state: NativeBindingState,
) -> RuntimeStartedDto {
    RuntimeStartedDto {
        runtime_id: runtime_id.to_string(),
        cli_session_id: entry.cli_session_id.clone(),
        pid: entry.process.pid(),
        provider: entry.provider,
        native_binding_state,
        shell: entry.process.shell_label().to_string(),
        engine: entry.process.engine_label().to_string(),
    }
}

fn tokens_equal(expected: &str, actual: &str) -> bool {
    if expected.len() != actual.len() {
        return false;
    }
    expected
        .as_bytes()
        .iter()
        .zip(actual.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        dto::DesiredState,
        ports::{PtyEventSink, PtyProcess, PtySpawnSpec},
    };
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::Duration,
    };

    #[test]
    fn session_end_preserves_agent_activity_and_turn_state() {
        for state in [
            (AgentActivity::Starting, false),
            (AgentActivity::Idle, false),
            (AgentActivity::Working, true),
            (AgentActivity::Blocked, true),
            (AgentActivity::Stopped, false),
        ] {
            assert_eq!(reduce_agent_activity(state.0, state.1, "SessionEnd"), state);
        }
    }

    #[test]
    fn output_flow_blocks_at_the_credit_limit_and_resumes_after_ack() {
        let flow = Arc::new(OutputFlow::new(8));
        assert!(flow.reserve(8));
        assert_eq!(flow.in_flight_bytes(), 8);

        let waiting_flow = Arc::clone(&flow);
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            started_tx.send(()).unwrap();
            finished_tx.send(waiting_flow.reserve(1)).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(finished_rx.recv_timeout(Duration::from_millis(40)).is_err());

        flow.acknowledge(1);
        assert!(finished_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
        assert_eq!(flow.in_flight_bytes(), 8);
    }

    #[test]
    fn output_flow_close_releases_waiting_dispatchers() {
        let flow = Arc::new(OutputFlow::new(1));
        assert!(flow.reserve(1));
        let waiting_flow = Arc::clone(&flow);
        let (finished_tx, finished_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            finished_tx.send(waiting_flow.reserve(1)).unwrap();
        });

        flow.close();
        assert!(!finished_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
        assert_eq!(flow.in_flight_bytes(), 0);
    }

    struct FakePtyBackend;

    impl PtyBackend for FakePtyBackend {
        fn spawn(
            &self,
            _spec: PtySpawnSpec,
            _event_sink: PtyEventSink,
        ) -> BackendResult<Arc<dyn PtyProcess>> {
            Ok(Arc::new(FakeProcess))
        }
    }

    struct EagerExitPtyBackend;

    impl PtyBackend for EagerExitPtyBackend {
        fn spawn(
            &self,
            _spec: PtySpawnSpec,
            event_sink: PtyEventSink,
        ) -> BackendResult<Arc<dyn PtyProcess>> {
            event_sink(PtyEvent::Output(b"startup ".to_vec()));
            event_sink(PtyEvent::Output(b"failed".to_vec()));
            event_sink(PtyEvent::Exit(9));
            Ok(Arc::new(FakeProcess))
        }
    }

    struct FakeProcess;

    struct ShutdownPtyBackend {
        process: Arc<CountingProcess>,
    }

    impl PtyBackend for ShutdownPtyBackend {
        fn spawn(
            &self,
            _spec: PtySpawnSpec,
            _event_sink: PtyEventSink,
        ) -> BackendResult<Arc<dyn PtyProcess>> {
            Ok(self.process.clone())
        }
    }

    #[derive(Default)]
    struct CountingProcess {
        stop_calls: AtomicUsize,
        shutdown_calls: AtomicUsize,
    }

    impl PtyProcess for FakeProcess {
        fn pid(&self) -> Option<u32> {
            Some(42)
        }

        fn shell_label(&self) -> &str {
            "Codex"
        }

        fn engine_label(&self) -> &str {
            "fake"
        }

        fn write(&self, _data: Vec<u8>) -> BackendResult<()> {
            Ok(())
        }

        fn resize(&self, _cols: u16, _rows: u16) -> BackendResult<()> {
            Ok(())
        }

        fn stop(&self) -> BackendResult<()> {
            Ok(())
        }
    }

    impl PtyProcess for CountingProcess {
        fn pid(&self) -> Option<u32> {
            Some(43)
        }

        fn shell_label(&self) -> &str {
            "Shell"
        }

        fn engine_label(&self) -> &str {
            "counting"
        }

        fn write(&self, _data: Vec<u8>) -> BackendResult<()> {
            Ok(())
        }

        fn resize(&self, _cols: u16, _rows: u16) -> BackendResult<()> {
            Ok(())
        }

        fn stop(&self) -> BackendResult<()> {
            self.stop_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn shutdown(&self) -> BackendResult<()> {
            self.shutdown_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn hook_report_requires_the_live_runtime_context() {
        let manager = RuntimeManager::new(Arc::new(FakePtyBackend));
        let session = CliSessionDto {
            id: "session-1".into(),
            space_id: "space-1".into(),
            provider: ProviderKind::Codex,
            cwd: ".".into(),
            native_session_id: None,
            native_binding_state: NativeBindingState::Pending,
            desired_state: DesiredState::Running,
            last_exit_summary: None,
        };
        let started = manager
            .start_session(
                session,
                80,
                24,
                Some(HookTransportDescriptor {
                    endpoint: "test-endpoint".into(),
                    reporter_path: "ccsm".into(),
                }),
                Arc::new(|_| {}),
            )
            .unwrap();
        assert_eq!(
            manager.agent_activity(&started.cli_session_id).unwrap(),
            Some((started.runtime_id.clone(), AgentActivity::Idle))
        );
        let token = manager
            .state
            .lock()
            .unwrap()
            .hook_registrations
            .get(&started.runtime_id)
            .unwrap()
            .token
            .clone();
        let report = HookReport {
            provider: ProviderKind::Codex,
            cli_session_id: started.cli_session_id.clone(),
            runtime_id: started.runtime_id.clone(),
            token,
            native_session_id: "native-1".into(),
            hook_event_name: "SessionStart".into(),
            transcript_path: Some("rollout.jsonl".into()),
            source: Some("startup".into()),
            parent_native_session_id: None,
            ephemeral: false,
            display_title: None,
        };
        let validated = manager.apply_hook_report(&report).unwrap();
        assert_eq!(validated.binding.native_session_id, "native-1");
        assert_eq!(validated.activity, AgentActivity::Idle);

        let mut prompt_report = report.clone();
        prompt_report.hook_event_name = "UserPromptSubmit".into();
        let prompt = manager.apply_hook_report(&prompt_report).unwrap();
        assert_eq!(prompt.activity, AgentActivity::Working);

        let mut permission_report = report.clone();
        permission_report.hook_event_name = "PermissionRequest".into();
        let permission = manager.apply_hook_report(&permission_report).unwrap();
        assert_eq!(permission.activity, AgentActivity::Blocked);

        let mut stop_report = report.clone();
        stop_report.hook_event_name = "Stop".into();
        let stop = manager.apply_hook_report(&stop_report).unwrap();
        assert_eq!(stop.activity, AgentActivity::Idle);

        let mut late_tool_report = report.clone();
        late_tool_report.hook_event_name = "PreToolUse".into();
        assert_eq!(
            manager
                .apply_hook_report(&late_tool_report)
                .unwrap()
                .activity,
            AgentActivity::Idle
        );

        let mut retry_prompt_report = report.clone();
        retry_prompt_report.hook_event_name = "UserPromptSubmit".into();
        let retry_prompt = manager.apply_hook_report(&retry_prompt_report).unwrap();
        assert_eq!(retry_prompt.activity, AgentActivity::Working);

        let mut notification_report = report.clone();
        notification_report.hook_event_name = "Notification".into();
        let notification = manager.apply_hook_report(&notification_report).unwrap();
        assert_eq!(notification.activity, AgentActivity::Blocked);

        let mut resumed_tool_report = report.clone();
        resumed_tool_report.hook_event_name = "PreToolUse".into();
        let resumed_tool = manager.apply_hook_report(&resumed_tool_report).unwrap();
        assert_eq!(resumed_tool.activity, AgentActivity::Working);

        let mut failure_report = report.clone();
        failure_report.hook_event_name = "StopFailure".into();
        let failure = manager.apply_hook_report(&failure_report).unwrap();
        assert_eq!(failure.activity, AgentActivity::Idle);

        let mut wrong_token = report.clone();
        wrong_token.token = "wrong".into();
        assert!(manager.apply_hook_report(&wrong_token).is_err());

        manager.remove_if_current(&report.cli_session_id, &report.runtime_id);
        assert!(manager.apply_hook_report(&report).is_err());
    }

    #[test]
    fn copilot_prompt_is_idle_before_its_lazy_session_start() {
        let manager = RuntimeManager::new(Arc::new(FakePtyBackend));
        let session = CliSessionDto {
            id: "copilot-session".into(),
            space_id: "space-1".into(),
            provider: ProviderKind::Copilot,
            cwd: ".".into(),
            native_session_id: None,
            native_binding_state: NativeBindingState::Pending,
            desired_state: DesiredState::Running,
            last_exit_summary: None,
        };
        let started = manager
            .start_session(
                session,
                80,
                24,
                Some(HookTransportDescriptor {
                    endpoint: "test-endpoint".into(),
                    reporter_path: "ccsm".into(),
                }),
                Arc::new(|_| {}),
            )
            .unwrap();

        assert_eq!(
            manager.agent_activity(&started.cli_session_id).unwrap(),
            Some((started.runtime_id, AgentActivity::Idle))
        );
    }

    #[test]
    fn eager_exit_is_dispatched_after_runtime_registration() {
        let manager = RuntimeManager::new(Arc::new(EagerExitPtyBackend));
        let session = CliSessionDto {
            id: "session-quick-exit".into(),
            space_id: "space-1".into(),
            provider: ProviderKind::Shell,
            cwd: ".".into(),
            native_session_id: None,
            native_binding_state: NativeBindingState::NotApplicable,
            desired_state: DesiredState::Running,
            last_exit_summary: None,
        };
        let (tx, rx) = mpsc::channel();
        let started = manager
            .start_session(
                session,
                80,
                24,
                None,
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            )
            .unwrap();

        assert!(matches!(
            rx.recv_timeout(std::time::Duration::from_secs(1))
                .unwrap(),
            RuntimeEvent::Output { data, .. } if data == b"startup failed"
        ));
        assert!(matches!(
            rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap(),
            RuntimeEvent::Exit { code: 9, .. }
        ));
        assert!(!manager.has_session(&started.cli_session_id).unwrap());
    }

    #[test]
    fn shutdown_releases_each_runtime_once() {
        let process = Arc::new(CountingProcess::default());
        let manager = RuntimeManager::new(Arc::new(ShutdownPtyBackend {
            process: Arc::clone(&process),
        }));
        let session = CliSessionDto {
            id: "session-shutdown".into(),
            space_id: "space-1".into(),
            provider: ProviderKind::Shell,
            cwd: ".".into(),
            native_session_id: None,
            native_binding_state: NativeBindingState::NotApplicable,
            desired_state: DesiredState::Running,
            last_exit_summary: None,
        };
        manager
            .start_session(session, 80, 24, None, Arc::new(|_| {}))
            .unwrap();

        manager.shutdown();
        manager.shutdown();

        assert_eq!(process.shutdown_calls.load(Ordering::SeqCst), 1);
        assert_eq!(process.stop_calls.load(Ordering::SeqCst), 0);
        assert!(!manager.has_session("session-shutdown").unwrap());
    }
}
