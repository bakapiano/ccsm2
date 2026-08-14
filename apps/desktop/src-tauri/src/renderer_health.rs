use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use ccsm_platform::{RendererHealthLogRecord, RendererHealthLogStats, SqliteStateStore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, WebviewWindow};
use ts_rs::TS;
use uuid::Uuid;

const INPUT_ACK_TIMEOUT_MS: u64 = 1_000;
const FAILURE_WINDOW_MS: u64 = 5_000;
const READY_TIMEOUT_MS: u64 = 15_000;
const RECOVERY_BUDGET_WINDOW_MS: u64 = 5 * 60 * 1_000;
const RECOVERY_BUDGET: usize = 2;
const MAX_PENDING_PROBES: usize = 8;

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct RendererInputProbe {
    pub input_seq: u32,
    pub observed_at_ms: f64,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct RendererInputAckRequest {
    pub input_seq: u32,
    pub dom_click_observed: bool,
    pub document_visible: bool,
    pub window_focused: bool,
    pub last_pointer_down_at_ms: Option<f64>,
    pub last_pointer_up_at_ms: Option<f64>,
    pub last_click_at_ms: Option<f64>,
    pub target_class: Option<String>,
    pub captured_pointer_count: u32,
    pub dock_dragging: bool,
    pub sidebar_resizing: bool,
    pub agents_resizing: bool,
    pub modal_kind: Option<String>,
    pub dirty_editor_count: u32,
    pub live_cli_runtime_count: u32,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct RendererReadyRequest {
    pub dirty_editor_count: u32,
    pub live_cli_runtime_count: u32,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct RendererReadyResponse {
    pub state: String,
    pub recovered: bool,
    pub incident_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct RendererHealthDebugSnapshot {
    pub state: String,
    pub native_input_observer_active: bool,
    pub native_input_event_count: f64,
    pub native_target_click_count: f64,
    pub native_main_browser_pid: u32,
    pub pending_probe_count: usize,
    pub missed_probe_count: u32,
    pub reload_count: u32,
    pub incident_id: Option<String>,
    pub log_row_count: i64,
    pub log_payload_bytes: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HealthPhase {
    Starting,
    Healthy,
    AwaitingInputAck,
    InputPathSuspect,
    InputPathUnresponsive,
    Recovering,
    RecoveryFailed,
}

impl HealthPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "Starting",
            Self::Healthy => "Healthy",
            Self::AwaitingInputAck => "AwaitingInputAck",
            Self::InputPathSuspect => "InputPathSuspect",
            Self::InputPathUnresponsive => "InputPathUnresponsive",
            Self::Recovering => "Recovering",
            Self::RecoveryFailed => "RecoveryFailed",
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct RendererRiskSnapshot {
    dirty_editor_count: u32,
    live_cli_runtime_count: u32,
}

#[derive(Clone, Copy, Debug)]
struct PendingProbe {
    observed_at_ms: u64,
}

struct MonitorState {
    phase: HealthPhase,
    next_input_seq: u32,
    pending: HashMap<u32, PendingProbe>,
    missed_probe_count: u32,
    last_failure_at_ms: Option<u64>,
    incident_id: Option<String>,
    last_snapshot: RendererRiskSnapshot,
    last_ack_details: Option<serde_json::Value>,
    recovery_deadline_ms: Option<u64>,
    recovery_times_ms: VecDeque<u64>,
    reload_count: u32,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            phase: HealthPhase::Starting,
            next_input_seq: 1,
            pending: HashMap::new(),
            missed_probe_count: 0,
            last_failure_at_ms: None,
            incident_id: None,
            last_snapshot: RendererRiskSnapshot::default(),
            last_ack_details: None,
            recovery_deadline_ms: None,
            recovery_times_ms: VecDeque::new(),
            reload_count: 0,
        }
    }
}

enum MonitorAction {
    Log {
        incident_id: String,
        event_kind: &'static str,
        input_seq: Option<u32>,
        state: &'static str,
        latency_ms: Option<u64>,
        details_json: String,
    },
    Reload {
        incident_id: String,
    },
}

pub struct RendererHealthMonitor {
    started_at: Instant,
    state: Mutex<MonitorState>,
    store: Arc<SqliteStateStore>,
    app: OnceLock<AppHandle>,
    main_window: OnceLock<WebviewWindow>,
    shutdown: AtomicBool,
    native_input_observer_active: AtomicBool,
    native_input_event_count: std::sync::atomic::AtomicU64,
    native_target_click_count: std::sync::atomic::AtomicU64,
    native_main_browser_pid: std::sync::atomic::AtomicU32,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl RendererHealthMonitor {
    pub fn new(store: Arc<SqliteStateStore>) -> Arc<Self> {
        Arc::new(Self {
            started_at: Instant::now(),
            state: Mutex::new(MonitorState::default()),
            store,
            app: OnceLock::new(),
            main_window: OnceLock::new(),
            shutdown: AtomicBool::new(false),
            native_input_observer_active: AtomicBool::new(false),
            native_input_event_count: std::sync::atomic::AtomicU64::new(0),
            native_target_click_count: std::sync::atomic::AtomicU64::new(0),
            native_main_browser_pid: std::sync::atomic::AtomicU32::new(0),
            worker: Mutex::new(None),
        })
    }

    pub fn start(self: &Arc<Self>, app: AppHandle, main_window: WebviewWindow) {
        let _ = self.app.set(app);
        let _ = self.main_window.set(main_window);
        let weak = Arc::downgrade(self);
        let worker = thread::Builder::new()
            .name("ccsm-renderer-health".into())
            .spawn(move || watchdog_loop(weak))
            .expect("start renderer health watchdog");
        if let Ok(mut slot) = self.worker.lock() {
            *slot = Some(worker);
        }
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        if let Ok(mut worker) = self.worker.lock()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
    }

    pub fn set_native_input_observer_active(&self, active: bool) {
        self.native_input_observer_active
            .store(active, Ordering::Release);
    }

    pub fn set_native_main_browser_pid(&self, process_id: u32) {
        self.native_main_browser_pid
            .store(process_id, Ordering::Release);
    }

    pub fn note_native_input_event(&self, targets_main_webview: bool) {
        self.native_input_event_count
            .fetch_add(1, Ordering::Relaxed);
        if targets_main_webview {
            self.native_target_click_count
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn observe_native_click(&self, bypass_window_gate: bool) -> Result<Option<u32>, String> {
        let app = self
            .app
            .get()
            .ok_or_else(|| "renderer health monitor is not started".to_string())?;
        if !bypass_window_gate
            && !self
                .main_window
                .get()
                .is_some_and(main_window_accepts_probe)
        {
            return Ok(None);
        }
        let now_ms = self.now_ms();
        let probe = {
            let mut state = self.lock_state()?;
            if matches!(
                state.phase,
                HealthPhase::Starting | HealthPhase::Recovering | HealthPhase::RecoveryFailed
            ) {
                return Ok(None);
            }
            let input_seq = state.next_input_seq;
            state.next_input_seq = state.next_input_seq.saturating_add(1);
            if state.pending.len() >= MAX_PENDING_PROBES
                && let Some(oldest) = state
                    .pending
                    .iter()
                    .min_by_key(|(_, pending)| pending.observed_at_ms)
                    .map(|(input_seq, _)| *input_seq)
            {
                state.pending.remove(&oldest);
            }
            state.pending.insert(
                input_seq,
                PendingProbe {
                    observed_at_ms: now_ms,
                },
            );
            state.phase = HealthPhase::AwaitingInputAck;
            RendererInputProbe {
                input_seq,
                observed_at_ms: epoch_millis(),
            }
        };
        app.emit("ccsm:renderer-input-probe", &probe)
            .map_err(|error| format!("emit renderer input probe failed: {error}"))?;
        Ok(Some(probe.input_seq))
    }

    pub fn acknowledge_input(&self, request: RendererInputAckRequest) -> Result<(), String> {
        let now_ms = self.now_ms();
        let ack_details = json!({
            "documentVisible": request.document_visible,
            "windowFocused": request.window_focused,
            "lastPointerDownAtMs": request.last_pointer_down_at_ms,
            "lastPointerUpAtMs": request.last_pointer_up_at_ms,
            "lastClickAtMs": request.last_click_at_ms,
            "targetClass": request.target_class,
            "capturedPointerCount": request.captured_pointer_count,
            "dockDragging": request.dock_dragging,
            "sidebarResizing": request.sidebar_resizing,
            "agentsResizing": request.agents_resizing,
            "modalKind": request.modal_kind,
        });
        let (actions, late_incident) = {
            let mut state = self.lock_state()?;
            state.last_snapshot = RendererRiskSnapshot {
                dirty_editor_count: request.dirty_editor_count,
                live_cli_runtime_count: request.live_cli_runtime_count,
            };
            state.last_ack_details = Some(ack_details.clone());
            match state.pending.remove(&request.input_seq) {
                None => (Vec::new(), state.incident_id.clone()),
                Some(pending) => {
                    let latency_ms = now_ms.saturating_sub(pending.observed_at_ms);
                    if request.dom_click_observed && latency_ms <= INPUT_ACK_TIMEOUT_MS {
                        let mut actions = Vec::new();
                        if let Some(incident_id) = state.incident_id.clone() {
                            actions.push(log_action(
                                incident_id,
                                "state.changed",
                                Some(request.input_seq),
                                HealthPhase::Healthy,
                                Some(latency_ms),
                                json!({ "reason": "matchingDomAck" }),
                            ));
                        }
                        state.phase = HealthPhase::Healthy;
                        state.missed_probe_count = 0;
                        state.last_failure_at_ms = None;
                        state.incident_id = None;
                        (actions, None)
                    } else {
                        let actions = record_failure_locked(
                            &mut state,
                            now_ms,
                            request.input_seq,
                            if request.dom_click_observed {
                                "input.lateAck"
                            } else {
                                "input.correlationFailed"
                            },
                            Some(latency_ms),
                            ack_details,
                        );
                        (actions, None)
                    }
                }
            }
        };
        if let Some(incident_id) = late_incident {
            self.process_actions(vec![log_action(
                incident_id,
                "input.lateAck",
                Some(request.input_seq),
                HealthPhase::InputPathSuspect,
                None,
                json!({ "reason": "unknownOrExpiredSequence" }),
            )]);
        }
        self.process_actions(actions);
        Ok(())
    }

    pub fn renderer_ready(
        &self,
        request: RendererReadyRequest,
    ) -> Result<RendererReadyResponse, String> {
        let (response, actions) = {
            let mut state = self.lock_state()?;
            state.last_snapshot = RendererRiskSnapshot {
                dirty_editor_count: request.dirty_editor_count,
                live_cli_runtime_count: request.live_cli_runtime_count,
            };
            state.last_ack_details = Some(json!({
                "rendererReady": true,
                "dirtyEditorCount": request.dirty_editor_count,
                "liveCliRuntimeCount": request.live_cli_runtime_count,
            }));
            let recovered = state.phase == HealthPhase::Recovering;
            let incident_id = recovered.then(|| state.incident_id.clone()).flatten();
            let mut actions = Vec::new();
            if let Some(incident_id) = incident_id.clone() {
                actions.push(log_action(
                    incident_id,
                    "recovery.completed",
                    None,
                    HealthPhase::Healthy,
                    None,
                    json!({ "reloadCount": state.reload_count }),
                ));
            }
            state.phase = HealthPhase::Healthy;
            state.pending.clear();
            state.missed_probe_count = 0;
            state.last_failure_at_ms = None;
            state.recovery_deadline_ms = None;
            state.incident_id = None;
            (
                RendererReadyResponse {
                    state: HealthPhase::Healthy.as_str().into(),
                    recovered,
                    incident_id,
                },
                actions,
            )
        };
        self.process_actions(actions);
        Ok(response)
    }

    pub fn debug_snapshot(&self) -> Result<RendererHealthDebugSnapshot, String> {
        let state = self.lock_state()?;
        let stats = self
            .store
            .renderer_health_log_stats()
            .map_err(|error| error.to_string())?;
        Ok(debug_snapshot(
            &state,
            stats,
            self.native_input_observer_active.load(Ordering::Acquire),
            self.native_input_event_count.load(Ordering::Relaxed),
            self.native_target_click_count.load(Ordering::Relaxed),
            self.native_main_browser_pid.load(Ordering::Acquire),
        ))
    }

    pub fn request_manual_recovery(&self) -> Result<String, String> {
        let now_ms = self.now_ms();
        let (incident_id, actions) = {
            let mut state = self.lock_state()?;
            if state.phase == HealthPhase::Recovering {
                return state
                    .incident_id
                    .clone()
                    .ok_or_else(|| "renderer recovery incident is unavailable".into());
            }
            let actions = begin_recovery_locked(&mut state, now_ms, "manualButton", None, None);
            let incident_id = state
                .incident_id
                .clone()
                .ok_or_else(|| "manual renderer recovery did not create an incident".to_string())?;
            (incident_id, actions)
        };
        self.process_actions(actions);
        Ok(incident_id)
    }

    pub fn manual_button_window_visible(&self) -> bool {
        self.main_window.get().is_some_and(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
        })
    }

    pub fn native_main_browser_pid(&self) -> u32 {
        self.native_main_browser_pid.load(Ordering::Acquire)
    }

    fn check_deadlines(&self) {
        let now_ms = self.now_ms();
        let actions = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let expired = state
                .pending
                .iter()
                .filter(|(_, probe)| {
                    now_ms.saturating_sub(probe.observed_at_ms) >= INPUT_ACK_TIMEOUT_MS
                })
                .map(|(input_seq, probe)| (*input_seq, probe.observed_at_ms))
                .collect::<Vec<_>>();
            let mut actions = Vec::new();
            for (input_seq, observed_at_ms) in expired {
                state.pending.remove(&input_seq);
                actions.extend(record_failure_locked(
                    &mut state,
                    now_ms,
                    input_seq,
                    "input.timeout",
                    Some(now_ms.saturating_sub(observed_at_ms)),
                    json!({ "reason": "ackTimeout" }),
                ));
            }
            if state.phase == HealthPhase::Recovering
                && state
                    .recovery_deadline_ms
                    .is_some_and(|deadline| now_ms >= deadline)
            {
                state.phase = HealthPhase::RecoveryFailed;
                if let Some(incident_id) = state.incident_id.clone() {
                    actions.push(log_action(
                        incident_id,
                        "recovery.failed",
                        None,
                        HealthPhase::RecoveryFailed,
                        None,
                        json!({ "reason": "rendererReadyTimeout" }),
                    ));
                }
                state.recovery_deadline_ms = None;
            }
            actions
        };
        self.process_actions(actions);
    }

    fn process_actions(&self, actions: Vec<MonitorAction>) {
        for action in actions {
            match action {
                MonitorAction::Log {
                    incident_id,
                    event_kind,
                    input_seq,
                    state,
                    latency_ms,
                    details_json,
                } => {
                    if let Err(error) =
                        self.store
                            .append_renderer_health_log(RendererHealthLogRecord {
                                incident_id,
                                recorded_at: epoch_seconds(),
                                event_kind: event_kind.into(),
                                input_seq: input_seq.map(u64::from),
                                state: state.into(),
                                latency_ms,
                                details_json,
                            })
                    {
                        eprintln!("CCSM renderer health log write failed: {error}");
                    }
                }
                MonitorAction::Reload { incident_id } => {
                    if self.app.get().is_none() {
                        continue;
                    }
                    let result = self
                        .main_window
                        .get()
                        .ok_or_else(|| "main WebView is unavailable".to_string())
                        .and_then(|window| window.reload().map_err(|error| error.to_string()));
                    if let Err(error) = result {
                        if let Ok(mut state) = self.state.lock() {
                            state.phase = HealthPhase::RecoveryFailed;
                            state.recovery_deadline_ms = None;
                        }
                        let _ = self
                            .store
                            .append_renderer_health_log(RendererHealthLogRecord {
                                incident_id,
                                recorded_at: epoch_seconds(),
                                event_kind: "recovery.failed".into(),
                                input_seq: None,
                                state: HealthPhase::RecoveryFailed.as_str().into(),
                                latency_ms: None,
                                details_json: json!({ "reason": error }).to_string(),
                            });
                    }
                }
            }
        }
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, MonitorState>, String> {
        self.state
            .lock()
            .map_err(|_| "renderer health state lock poisoned".into())
    }

    fn now_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
}

fn record_failure_locked(
    state: &mut MonitorState,
    now_ms: u64,
    input_seq: u32,
    event_kind: &'static str,
    latency_ms: Option<u64>,
    mut details: serde_json::Value,
) -> Vec<MonitorAction> {
    let incident_id = state
        .incident_id
        .get_or_insert_with(|| Uuid::new_v4().to_string())
        .clone();
    let consecutive = state
        .last_failure_at_ms
        .is_some_and(|previous| now_ms.saturating_sub(previous) <= FAILURE_WINDOW_MS);
    state.missed_probe_count = if consecutive {
        state.missed_probe_count.saturating_add(1)
    } else {
        1
    };
    state.last_failure_at_ms = Some(now_ms);
    state.phase = if state.missed_probe_count >= 2 {
        HealthPhase::InputPathUnresponsive
    } else {
        HealthPhase::InputPathSuspect
    };
    if let Some(details) = details.as_object_mut() {
        details.insert("missedProbeCount".into(), state.missed_probe_count.into());
    }
    let mut actions = vec![log_action(
        incident_id.clone(),
        event_kind,
        Some(input_seq),
        state.phase,
        latency_ms,
        details,
    )];
    if state.phase == HealthPhase::InputPathUnresponsive
        && state.last_snapshot.dirty_editor_count == 0
    {
        while state
            .recovery_times_ms
            .front()
            .is_some_and(|timestamp| now_ms.saturating_sub(*timestamp) > RECOVERY_BUDGET_WINDOW_MS)
        {
            state.recovery_times_ms.pop_front();
        }
        if state.recovery_times_ms.len() < RECOVERY_BUDGET {
            state.recovery_times_ms.push_back(now_ms);
            actions.extend(begin_recovery_locked(
                state,
                now_ms,
                "automaticInputTimeout",
                Some(input_seq),
                latency_ms,
            ));
        }
    }
    actions
}

fn begin_recovery_locked(
    state: &mut MonitorState,
    now_ms: u64,
    trigger: &'static str,
    input_seq: Option<u32>,
    latency_ms: Option<u64>,
) -> Vec<MonitorAction> {
    let incident_id = state
        .incident_id
        .get_or_insert_with(|| Uuid::new_v4().to_string())
        .clone();
    let previous_state = state.phase;
    let pending_probe_count = state.pending.len();
    state.reload_count = state.reload_count.saturating_add(1);
    state.phase = HealthPhase::Recovering;
    state.pending.clear();
    state.recovery_deadline_ms = Some(now_ms.saturating_add(READY_TIMEOUT_MS));
    let scene = json!({
        "trigger": trigger,
        "previousState": previous_state.as_str(),
        "pendingProbeCount": pending_probe_count,
        "missedProbeCount": state.missed_probe_count,
        "dirtyEditorCount": state.last_snapshot.dirty_editor_count,
        "liveCliRuntimeCount": state.last_snapshot.live_cli_runtime_count,
        "lastAck": state.last_ack_details.clone(),
    });
    vec![
        log_action(
            incident_id.clone(),
            "diagnostic.captured",
            input_seq,
            HealthPhase::Recovering,
            latency_ms,
            scene,
        ),
        log_action(
            incident_id.clone(),
            "recovery.requested",
            input_seq,
            HealthPhase::Recovering,
            latency_ms,
            json!({ "trigger": trigger, "reloadCount": state.reload_count }),
        ),
        MonitorAction::Reload { incident_id },
    ]
}

fn log_action(
    incident_id: String,
    event_kind: &'static str,
    input_seq: Option<u32>,
    state: HealthPhase,
    latency_ms: Option<u64>,
    details: serde_json::Value,
) -> MonitorAction {
    MonitorAction::Log {
        incident_id,
        event_kind,
        input_seq,
        state: state.as_str(),
        latency_ms,
        details_json: details.to_string(),
    }
}

fn watchdog_loop(monitor: Weak<RendererHealthMonitor>) {
    loop {
        thread::sleep(Duration::from_millis(50));
        let Some(monitor) = monitor.upgrade() else {
            return;
        };
        if monitor.shutdown.load(Ordering::Acquire) {
            return;
        }
        monitor.check_deadlines();
    }
}

fn debug_snapshot(
    state: &MonitorState,
    stats: RendererHealthLogStats,
    native_input_observer_active: bool,
    native_input_event_count: u64,
    native_target_click_count: u64,
    native_main_browser_pid: u32,
) -> RendererHealthDebugSnapshot {
    RendererHealthDebugSnapshot {
        state: state.phase.as_str().into(),
        native_input_observer_active,
        native_input_event_count: native_input_event_count as f64,
        native_target_click_count: native_target_click_count as f64,
        native_main_browser_pid,
        pending_probe_count: state.pending.len(),
        missed_probe_count: state.missed_probe_count,
        reload_count: state.reload_count,
        incident_id: state.incident_id.clone(),
        log_row_count: stats.row_count,
        log_payload_bytes: stats.payload_bytes,
    }
}

fn main_window_accepts_probe(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(true)
        && window.is_focused().unwrap_or(false)
}

fn epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn epoch_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_failed_probes_within_window_request_recovery() {
        let mut state = MonitorState {
            phase: HealthPhase::Healthy,
            ..MonitorState::default()
        };
        let first = record_failure_locked(
            &mut state,
            1_000,
            1,
            "input.timeout",
            Some(1_000),
            json!({}),
        );
        assert_eq!(state.phase, HealthPhase::InputPathSuspect);
        assert!(
            !first
                .iter()
                .any(|action| matches!(action, MonitorAction::Reload { .. }))
        );

        let second = record_failure_locked(
            &mut state,
            3_000,
            2,
            "input.timeout",
            Some(1_000),
            json!({}),
        );
        assert_eq!(state.phase, HealthPhase::Recovering);
        assert!(
            second
                .iter()
                .any(|action| matches!(action, MonitorAction::Reload { .. }))
        );
    }

    #[test]
    fn dirty_editor_blocks_automatic_reload() {
        let mut state = MonitorState {
            phase: HealthPhase::Healthy,
            last_snapshot: RendererRiskSnapshot {
                dirty_editor_count: 1,
                live_cli_runtime_count: 0,
            },
            ..MonitorState::default()
        };
        record_failure_locked(
            &mut state,
            1_000,
            1,
            "input.timeout",
            Some(1_000),
            json!({}),
        );
        let second = record_failure_locked(
            &mut state,
            2_000,
            2,
            "input.timeout",
            Some(1_000),
            json!({}),
        );
        assert_eq!(state.phase, HealthPhase::InputPathUnresponsive);
        assert!(
            !second
                .iter()
                .any(|action| matches!(action, MonitorAction::Reload { .. }))
        );
    }

    #[test]
    fn manual_recovery_records_scene_and_overrides_dirty_guard() {
        let mut state = MonitorState {
            phase: HealthPhase::Healthy,
            last_snapshot: RendererRiskSnapshot {
                dirty_editor_count: 2,
                live_cli_runtime_count: 3,
            },
            last_ack_details: Some(json!({ "targetClass": "terminal-host" })),
            ..MonitorState::default()
        };

        let actions = begin_recovery_locked(&mut state, 4_000, "manualButton", None, None);

        assert_eq!(state.phase, HealthPhase::Recovering);
        assert_eq!(state.reload_count, 1);
        let diagnostic = actions
            .iter()
            .find_map(|action| match action {
                MonitorAction::Log {
                    event_kind: "diagnostic.captured",
                    details_json,
                    ..
                } => serde_json::from_str::<serde_json::Value>(details_json).ok(),
                _ => None,
            })
            .expect("manual recovery diagnostic");
        assert_eq!(diagnostic["trigger"], "manualButton");
        assert_eq!(diagnostic["previousState"], "Healthy");
        assert_eq!(diagnostic["dirtyEditorCount"], 2);
        assert_eq!(diagnostic["liveCliRuntimeCount"], 3);
        assert_eq!(diagnostic["lastAck"]["targetClass"], "terminal-host");
        assert!(actions.iter().any(|action| matches!(
            action,
            MonitorAction::Log {
                event_kind: "recovery.requested",
                ..
            }
        )));
        assert!(
            actions
                .iter()
                .any(|action| matches!(action, MonitorAction::Reload { .. }))
        );
    }

    #[test]
    fn failures_outside_window_are_not_consecutive() {
        let mut state = MonitorState {
            phase: HealthPhase::Healthy,
            ..MonitorState::default()
        };
        record_failure_locked(
            &mut state,
            1_000,
            1,
            "input.timeout",
            Some(1_000),
            json!({}),
        );
        let second = record_failure_locked(
            &mut state,
            1_000 + FAILURE_WINDOW_MS + 1,
            2,
            "input.timeout",
            Some(1_000),
            json!({}),
        );
        assert_eq!(state.phase, HealthPhase::InputPathSuspect);
        assert!(
            !second
                .iter()
                .any(|action| matches!(action, MonitorAction::Reload { .. }))
        );
    }
}
