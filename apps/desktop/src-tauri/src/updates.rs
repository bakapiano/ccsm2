use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

#[cfg(windows)]
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State, Url, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};
use ts_rs::TS;

use crate::DesktopState;

const CHECK_TIMEOUT: Duration = Duration::from_secs(8);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const WINDOWS_NSIS_UPDATE_ARGUMENTS: [&str; 2] = ["/P", "/UPDATE"];
const WINDOWS_E2E_NSIS_UPDATE_ARGUMENTS: [&str; 3] = ["/P", "/UPDATE", "/R"];

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct UpdateInfoDto {
    pub id: String,
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct UpdateProgressDto {
    #[ts(type = "number")]
    pub downloaded_bytes: u64,
    #[ts(type = "number | null")]
    pub total_bytes: Option<u64>,
    pub source: String,
}

struct PendingUpdate {
    id: String,
    source_index: usize,
    info: UpdateInfoDto,
    update: Update,
    bytes: Option<Vec<u8>>,
}

pub struct UpdateState {
    endpoints: Vec<Url>,
    pending: Mutex<Option<PendingUpdate>>,
    operation_active: AtomicBool,
    next_id: AtomicU64,
}

impl UpdateState {
    pub fn from_app<R: Runtime>(app: &tauri::App<R>) -> Result<Self, String> {
        let plugin_config = app
            .config()
            .plugins
            .0
            .get("updater")
            .ok_or_else(|| "missing plugins.updater configuration".to_string())?;
        let endpoints = configured_endpoints(plugin_config)?;
        Ok(Self {
            endpoints,
            pending: Mutex::new(None),
            operation_active: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
        })
    }

    fn begin_operation(&self) -> Result<OperationGuard<'_>, String> {
        self.operation_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "another update operation is already running".to_string())?;
        Ok(OperationGuard {
            active: &self.operation_active,
        })
    }
}

struct OperationGuard<'a> {
    active: &'a AtomicBool,
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateInfoDto>, String> {
    ensure_updater_enabled()?;
    let _operation = state.begin_operation()?;
    let mut failures = Vec::new();

    for (source_index, endpoint) in state.endpoints.iter().enumerate() {
        match check_endpoint(&app, endpoint.clone()).await {
            Ok(Some(update)) => {
                let id = format!("update-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
                let source = source_name(endpoint, source_index);
                let info = update_info(&id, &source, &update);
                *state
                    .pending
                    .lock()
                    .map_err(|_| "update state lock is poisoned".to_string())? =
                    Some(PendingUpdate {
                        id,
                        source_index,
                        info: info.clone(),
                        update,
                        bytes: None,
                    });
                return Ok(Some(info));
            }
            Ok(None) => {
                *state
                    .pending
                    .lock()
                    .map_err(|_| "update state lock is poisoned".to_string())? = None;
                return Ok(None);
            }
            Err(error) => {
                failures.push(format!("{}: {error}", source_name(endpoint, source_index)))
            }
        }
    }

    Err(aggregate_failures("update check", &failures))
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    update_id: String,
    on_progress: Channel<UpdateProgressDto>,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    ensure_updater_enabled()?;
    let _operation = state.begin_operation()?;
    let (version, first_source, first_update) = {
        let pending = state
            .pending
            .lock()
            .map_err(|_| "update state lock is poisoned".to_string())?;
        let pending = pending
            .as_ref()
            .filter(|pending| pending.id == update_id)
            .ok_or_else(|| "the selected update is no longer available".to_string())?;
        (
            pending.info.version.clone(),
            pending.source_index,
            pending.update.clone(),
        )
    };
    let mut failures = Vec::new();

    for source_index in first_source..state.endpoints.len() {
        let endpoint = &state.endpoints[source_index];
        let source = source_name(endpoint, source_index);
        let candidate = if source_index == first_source {
            Some(first_update.clone())
        } else {
            match check_endpoint(&app, endpoint.clone()).await {
                Ok(candidate) => candidate,
                Err(error) => {
                    failures.push(format!("{source}: {error}"));
                    continue;
                }
            }
        };
        let Some(mut candidate) = candidate else {
            failures.push(format!("{source}: no matching update"));
            continue;
        };
        if candidate.version != version {
            failures.push(format!(
                "{source}: expected version {version}, received {}",
                candidate.version
            ));
            continue;
        }
        candidate.timeout = Some(DOWNLOAD_TIMEOUT);
        let mut downloaded_bytes = 0_u64;
        match candidate
            .download(
                |chunk_bytes, total_bytes| {
                    downloaded_bytes = downloaded_bytes.saturating_add(chunk_bytes as u64);
                    let _ = on_progress.send(UpdateProgressDto {
                        downloaded_bytes,
                        total_bytes,
                        source: source.clone(),
                    });
                },
                || {},
            )
            .await
        {
            Ok(bytes) => {
                let mut pending = state
                    .pending
                    .lock()
                    .map_err(|_| "update state lock is poisoned".to_string())?;
                let pending = pending
                    .as_mut()
                    .filter(|pending| pending.id == update_id)
                    .ok_or_else(|| "the selected update changed during download".to_string())?;
                pending.source_index = source_index;
                pending.info.source = source;
                pending.update = candidate;
                pending.bytes = Some(bytes);
                return Ok(());
            }
            Err(error) => failures.push(format!("{source}: {error}")),
        }
    }

    Err(aggregate_failures("update download", &failures))
}

#[tauri::command]
pub fn install_update(
    app: AppHandle,
    update_id: String,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    ensure_updater_enabled()?;
    let _operation = state.begin_operation()?;
    let (_update, bytes) = {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "update state lock is poisoned".to_string())?;
        let pending = pending
            .as_mut()
            .filter(|pending| pending.id == update_id)
            .ok_or_else(|| "the selected update is no longer available".to_string())?;
        let bytes = pending
            .bytes
            .take()
            .ok_or_else(|| "download the update before installing it".to_string())?;
        (pending.update.clone(), bytes)
    };
    #[cfg(windows)]
    let install_result = install_windows_nsis_update(&app, &update_id, &bytes);
    #[cfg(not(windows))]
    let install_result = _update
        .install(&bytes)
        .map_err(|error| format!("install update failed: {error}"));
    if let Err(error) = install_result {
        if let Ok(mut pending) = state.pending.lock()
            && let Some(pending) = pending.as_mut().filter(|pending| pending.id == update_id)
        {
            pending.bytes = Some(bytes);
        }
        return Err(error);
    }

    if let Ok(mut pending) = state.pending.lock() {
        *pending = None;
    }

    #[cfg(not(windows))]
    app.request_restart();

    Ok(())
}

#[cfg(windows)]
fn install_windows_nsis_update(
    app: &AppHandle,
    update_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if !is_windows_executable(bytes) {
        return Err("install update failed: invalid NSIS executable".to_string());
    }
    let directory =
        std::env::temp_dir().join(format!("ccsm-{}-{update_id}-updater", std::process::id()));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("create NSIS updater directory failed: {error}"))?;
    let installer = directory.join("CCSM-update.exe");
    std::fs::write(&installer, bytes)
        .map_err(|error| format!("write NSIS updater failed: {error}"))?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve installed CCSM executable failed: {error}"))?;
    #[cfg(feature = "e2e")]
    if let Some(handoff_path) =
        std::env::var_os("CCSM_E2E_WINDOWS_UPDATER_HANDOFF_FILE").filter(|value| !value.is_empty())
    {
        write_windows_e2e_handoff(std::path::Path::new(&handoff_path), &installer, &executable)?;
        shutdown_for_windows_update(app);
    }
    launch_windows_update_helper(&installer, &executable, &directory)?;
    std::thread::sleep(Duration::from_millis(750));
    shutdown_for_windows_update(app);
}

#[cfg(windows)]
fn shutdown_for_windows_update(app: &AppHandle) -> ! {
    if let Some(state) = app.try_state::<DesktopState>() {
        state.shutdown(app);
    }
    app.cleanup_before_exit();
    std::process::exit(0)
}

#[cfg(all(windows, feature = "e2e"))]
fn write_windows_e2e_handoff(
    handoff_path: &std::path::Path,
    installer: &std::path::Path,
    executable: &std::path::Path,
) -> Result<(), String> {
    if let Some(parent) = handoff_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create Windows updater handoff directory failed: {error}"))?;
    }
    let handoff = serde_json::json!({
        "installerPath": installer,
        "executablePath": executable,
        "arguments": WINDOWS_E2E_NSIS_UPDATE_ARGUMENTS,
    });
    std::fs::write(
        handoff_path,
        serde_json::to_vec_pretty(&handoff)
            .map_err(|error| format!("serialize Windows updater handoff failed: {error}"))?,
    )
    .map_err(|error| format!("write Windows updater handoff failed: {error}"))
}

#[cfg(windows)]
fn launch_windows_update_helper(
    installer: &std::path::Path,
    executable: &std::path::Path,
    directory: &std::path::Path,
) -> Result<(), String> {
    use std::{os::windows::process::CommandExt, process::Stdio};
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

    let error_log = directory.join("CCSM-update-error.log");
    let status_log = directory.join("CCSM-update-status.log");
    let worker_script = format!(
        r#"$ErrorActionPreference='Stop'; $status='{}'; try {{ 'worker-started' | Out-File -LiteralPath $status -Encoding utf8; Start-Sleep -Milliseconds 1500; 'handoff-delay-complete' | Add-Content -LiteralPath $status; $installer=Start-Process -FilePath '{}' -ArgumentList @('{}','{}') -Wait -PassThru; "installer-exit=$($installer.ExitCode)" | Add-Content -LiteralPath $status; if ($installer.ExitCode -ne 0) {{ exit $installer.ExitCode }}; Start-Process -FilePath '{}'; 'restart-launched' | Add-Content -LiteralPath $status }} catch {{ $_ | Out-File -LiteralPath '{}' -Encoding utf8; exit 1 }}"#,
        powershell_literal(&status_log),
        powershell_literal(installer),
        WINDOWS_NSIS_UPDATE_ARGUMENTS[0],
        WINDOWS_NSIS_UPDATE_ARGUMENTS[1],
        powershell_literal(executable),
        powershell_literal(&error_log),
    );
    let worker_command = encode_powershell_command(&worker_script);
    let creation_flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
    launch_with_optional_job_breakaway(creation_flags, |flags| {
        std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-EncodedCommand",
                &worker_command,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(flags)
            .spawn()
            .map(|_| ())
    })
    .map_err(|error| format!("launch NSIS updater helper failed: {error}"))
}

#[cfg(windows)]
fn launch_with_optional_job_breakaway(
    creation_flags: u32,
    mut launch: impl FnMut(u32) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;

    match launch(creation_flags | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            launch(creation_flags)
        }
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn encode_powershell_command(script: &str) -> String {
    let command_bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    base64::engine::general_purpose::STANDARD.encode(command_bytes)
}

#[cfg(windows)]
fn powershell_literal(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

fn is_windows_executable(bytes: &[u8]) -> bool {
    bytes.starts_with(b"MZ")
}

async fn check_endpoint(app: &AppHandle, endpoint: Url) -> Result<Option<Update>, String> {
    let exit_app = app.clone();
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(CHECK_TIMEOUT)
        .on_before_exit(move || {
            if let Some(state) = exit_app.try_state::<DesktopState>() {
                state.shutdown(&exit_app);
            }
            exit_app.cleanup_before_exit();
        })
        .build()
        .map_err(|error| error.to_string())?;
    updater.check().await.map_err(|error| error.to_string())
}

fn configured_endpoints(plugin_config: &serde_json::Value) -> Result<Vec<Url>, String> {
    let values = plugin_config
        .get("endpoints")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "plugins.updater.endpoints must be an array".to_string())?;
    let endpoints = values
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "update endpoint must be a string".to_string())?
                .parse::<Url>()
                .map_err(|error| format!("invalid update endpoint: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if endpoints.is_empty() {
        return Err("configure at least one update endpoint".to_string());
    }
    Ok(endpoints)
}

fn update_info(id: &str, source: &str, update: &Update) -> UpdateInfoDto {
    UpdateInfoDto {
        id: id.to_string(),
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        notes: update.body.clone(),
        pub_date: update.date.map(|date| date.to_string()),
        source: source.to_string(),
    }
}

fn source_name(endpoint: &Url, index: usize) -> String {
    endpoint
        .host_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("endpoint {}", index + 1))
}

fn aggregate_failures(operation: &str, failures: &[String]) -> String {
    if failures.is_empty() {
        format!("{operation} failed")
    } else {
        format!("{operation} failed: {}", failures.join("; "))
    }
}

fn ensure_updater_enabled() -> Result<(), String> {
    if !cfg!(debug_assertions) || std::env::var("CCSM_ENABLE_UPDATER").as_deref() == Ok("1") {
        Ok(())
    } else {
        Err("update checks are available in installed release builds".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ordered_endpoints_from_plugin_config() {
        let config = serde_json::json!({
            "endpoints": [
                "https://updates-cn.example.com/latest.json",
                "https://github.com/example/releases/latest.json"
            ]
        });
        let endpoints = configured_endpoints(&config).expect("endpoints should parse");
        assert_eq!(endpoints.len(), 2);
        assert_eq!(source_name(&endpoints[0], 0), "updates-cn.example.com");
        assert_eq!(source_name(&endpoints[1], 1), "github.com");
    }

    #[test]
    fn rejects_empty_endpoint_configuration() {
        let error = configured_endpoints(&serde_json::json!({ "endpoints": [] }))
            .expect_err("empty endpoints should fail");
        assert!(error.contains("at least one"));
    }

    #[test]
    fn serializes_progress_for_the_typescript_channel() {
        let progress = UpdateProgressDto {
            downloaded_bytes: 512,
            total_bytes: Some(1024),
            source: "mirror.example.com".to_string(),
        };
        assert_eq!(
            serde_json::to_value(progress).expect("progress should serialize"),
            serde_json::json!({
                "downloadedBytes": 512,
                "totalBytes": 1024,
                "source": "mirror.example.com"
            })
        );
    }

    #[test]
    fn windows_handoff_uses_the_proven_passive_restart_arguments() {
        assert_eq!(WINDOWS_NSIS_UPDATE_ARGUMENTS, ["/P", "/UPDATE"]);
        assert_eq!(WINDOWS_E2E_NSIS_UPDATE_ARGUMENTS, ["/P", "/UPDATE", "/R"]);
        assert!(is_windows_executable(b"MZsigned updater bytes"));
        assert!(!is_windows_executable(b"not an executable"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_helper_retries_inside_a_restricted_job() {
        use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;

        let creation_flags = 0x1234;
        let mut attempts = Vec::new();
        launch_with_optional_job_breakaway(creation_flags, |flags| {
            attempts.push(flags);
            if attempts.len() == 1 {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        })
        .expect("the helper should start inside a job that blocks breakaway");

        assert_eq!(
            attempts,
            vec![creation_flags | CREATE_BREAKAWAY_FROM_JOB, creation_flags]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_helper_preserves_other_launch_errors() {
        let creation_flags = 0x1234;
        let mut attempts = Vec::new();
        let error = launch_with_optional_job_breakaway(creation_flags, |flags| {
            attempts.push(flags);
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        })
        .expect_err("an unrelated launch failure should be returned");

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert_eq!(attempts.len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_helper_starts_a_real_process_from_the_current_job() {
        use std::{os::windows::process::CommandExt, process::Stdio};
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

        launch_with_optional_job_breakaway(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW, |flags| {
            std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "exit", "0"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(flags)
                .status()
                .and_then(|status| {
                    if status.success() {
                        Ok(())
                    } else {
                        Err(std::io::Error::other(format!(
                            "helper probe exited with {status}"
                        )))
                    }
                })
        })
        .expect("the helper probe should launch from the current Windows job");
    }
}
