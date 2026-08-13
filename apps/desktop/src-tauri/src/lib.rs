mod browser;
mod commands;
mod directory_browser;

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use browser::BrowserSurfaceManager;
use ccsm_core::{AppBackend, AppEventSink, HookTransportDescriptor};
use ccsm_platform::{
    CommandGitBackend, HookReportSink, LocalFileSystemBackend, LocalHookEndpoint,
    NotifyFileWatchBackend, PortablePtyBackend, SqliteStateStore,
};
use tauri::{Emitter, Manager, RunEvent};

pub struct DesktopState {
    backend: Arc<AppBackend>,
    browser: BrowserSurfaceManager,
    default_root: PathBuf,
    home_dir: PathBuf,
    hook_endpoint: LocalHookEndpoint,
    shim_root: PathBuf,
    shutdown_started: AtomicBool,
}

impl DesktopState {
    fn shutdown(&self, app: &tauri::AppHandle) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.browser.shutdown(app);
        self.backend.shutdown();
        self.hook_endpoint.shutdown();
        let _ = std::fs::remove_dir(&self.shim_root);
    }
}

pub fn run() {
    let data_dir_override = argument_value("--ccsm-data-dir")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CCSM_DATA_DIR").map(PathBuf::from));
    let claude_model_override =
        argument_value("--ccsm-claude-model").or_else(|| std::env::var("CCSM_CLAUDE_MODEL").ok());
    let claude_base_url_override = argument_value("--ccsm-claude-base-url")
        .or_else(|| std::env::var("CCSM_CLAUDE_BASE_URL").ok())
        .map(|value| {
            if value.contains("://") {
                value
            } else {
                format!("http://{value}")
            }
        });
    let raw_claude_path_override = argument_value("--ccsm-raw-claude-path")
        .or_else(|| std::env::var("CCSM_REAL_CLAUDE_PATH").ok());
    let app = tauri::Builder::default()
        .setup(move |app| {
            let data_dir = data_dir_override
                .filter(|value| !value.as_os_str().is_empty())
                .map(Ok)
                .unwrap_or_else(|| {
                    app.path().app_local_data_dir().map_err(|error| {
                        format!("resolve application data directory failed: {error}")
                    })
                })?;
            std::fs::create_dir_all(&data_dir)?;
            let executable = std::env::current_exe()
                .map_err(|error| format!("resolve CCSM executable failed: {error}"))?;
            let shim_root = runtime_shim_root(&executable, &data_dir);
            let default_root = std::env::current_dir().unwrap_or_else(|_| data_dir.clone());
            let home_dir = app
                .path()
                .home_dir()
                .unwrap_or_else(|_| default_root.clone());
            let store = Arc::new(
                SqliteStateStore::open(&data_dir.join("data.db"))
                    .map_err(|error| error.to_string())?,
            );
            let pty = Arc::new(
                PortablePtyBackend::new(shim_root.clone(), executable.clone())
                    .map_err(|error| error.to_string())?
                    .with_claude_overrides(
                        claude_model_override.clone(),
                        claude_base_url_override.clone(),
                        raw_claude_path_override.clone(),
                    ),
            );
            let filesystem = Arc::new(LocalFileSystemBackend::new());
            let git = Arc::new(CommandGitBackend::new());
            let file_watch = Arc::new(NotifyFileWatchBackend::new().with_ignored_paths([
                data_dir.clone(),
                home_dir.join(".ccsm"),
                shim_root.clone(),
            ]));
            let app_handle = app.handle().clone();
            let event_sink: AppEventSink = Arc::new(move |event| {
                let _ = app_handle.emit("ccsm:event", event);
            });
            let backend = AppBackend::new(store, pty, filesystem, git, file_watch, event_sink);
            let hook_backend = Arc::clone(&backend);
            let hook_sink: HookReportSink = Arc::new(move |report| {
                if let Err(error) = hook_backend.report_hook(report) {
                    eprintln!("CCSM Hook report rejected: {error}");
                }
            });
            let hook_endpoint =
                LocalHookEndpoint::start(hook_sink).map_err(|error| error.to_string())?;
            backend
                .configure_hook_transport(HookTransportDescriptor {
                    endpoint: hook_endpoint.address().to_string(),
                    reporter_path: executable.to_string_lossy().into_owned(),
                })
                .map_err(|error| error.to_string())?;
            let browser = BrowserSurfaceManager::new(data_dir.join("browser-profile"))?;
            app.manage(DesktopState {
                backend,
                browser,
                default_root,
                home_dir,
                hook_endpoint,
                shim_root,
                shutdown_started: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::list_agents,
            commands::load_space,
            commands::switch_space,
            commands::create_space,
            commands::rename_space,
            commands::delete_space,
            commands::create_folder,
            commands::rename_folder,
            commands::set_folder_collapsed,
            commands::delete_folder,
            commands::move_space,
            commands::move_folder,
            commands::save_layout,
            commands::update_tab_state,
            commands::delete_tab,
            commands::create_cli_tab,
            commands::create_browser_tab,
            commands::create_file_explorer_tab,
            commands::create_file_editor_tab,
            commands::create_git_tab,
            commands::get_cli_session,
            commands::replace_cli_session,
            commands::list_directory,
            commands::read_file,
            commands::resolve_file_reference,
            commands::write_file,
            commands::browse_host_directory,
            commands::create_host_directory,
            commands::cached_git,
            commands::refresh_git,
            commands::start_runtime,
            commands::write_runtime,
            commands::resize_runtime,
            commands::stop_runtime,
            commands::create_browser,
            commands::set_browser_bounds,
            commands::set_browser_visible,
            commands::capture_browser,
            commands::focus_browser,
            commands::navigate_browser,
            commands::reload_browser,
            commands::close_browser,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build CCSM desktop application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<DesktopState>() {
                state.shutdown(app_handle);
            }
        }
    });
}

fn argument_value(name: &str) -> Option<String> {
    let joined = format!("{name}=");
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if let Some(value) = argument.strip_prefix(&joined) {
            return (!value.is_empty()).then(|| value.to_string());
        }
        if argument == name {
            return arguments.next().filter(|value| !value.is_empty());
        }
    }
    None
}

fn runtime_shim_root(executable: &std::path::Path, data_dir: &std::path::Path) -> PathBuf {
    let suffix = format!("ccsm-runtime-shims-{}", std::process::id());
    if let Some(parent) = executable.parent() {
        ccsm_platform::cleanup_stale_runtime_shim_roots(parent);
        let adjacent = parent.join(&suffix);
        if std::fs::create_dir(&adjacent).is_ok() {
            return adjacent;
        }
    }
    ccsm_platform::cleanup_stale_runtime_shim_roots(data_dir);
    data_dir.join(suffix)
}
