mod browser;
mod commands;
mod directory_browser;
mod runtime_channel;
mod updates;
mod webview_focus;

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
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

use webview_focus::MainWebviewFocusRestorer;

pub struct DesktopState {
    backend: Arc<AppBackend>,
    filesystem: Arc<LocalFileSystemBackend>,
    browser: BrowserSurfaceManager,
    default_root: PathBuf,
    home_dir: PathBuf,
    hook_endpoint: LocalHookEndpoint,
    main_webview_focus: Mutex<Option<MainWebviewFocusRestorer>>,
    shim_root: PathBuf,
    shutdown_started: AtomicBool,
}

impl DesktopState {
    fn shutdown(&self, app: &tauri::AppHandle) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(restorer) = self.main_webview_focus.lock()
            && let Some(restorer) = restorer.as_ref()
        {
            restorer.shutdown();
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
        .or_else(|| std::env::var_os("CCSM_DATA_DIR").map(PathBuf::from))
        .filter(|value| !value.as_os_str().is_empty());
    let main_webview_data_dir = data_dir_override
        .as_ref()
        .filter(|_| !cfg!(feature = "e2e"))
        .map(|data_dir| data_dir.join("main-webview"));
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
    let mut context = tauri::generate_context!();
    let isolated_main_window = main_webview_data_dir.as_ref().map(|_| {
        let windows = &mut context.config_mut().app.windows;
        let main_window_index = windows
            .iter()
            .position(|window| window.label == "main")
            .expect("CCSM main window is missing from the Tauri configuration");
        windows.remove(main_window_index)
    });
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    let app = builder
        .setup(move |app| {
            app.manage(updates::UpdateState::from_app(app)?);
            let data_dir = data_dir_override.map(Ok).unwrap_or_else(|| {
                app.path()
                    .app_local_data_dir()
                    .map_err(|error| format!("resolve application data directory failed: {error}"))
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
            let backend =
                AppBackend::new(store, pty, filesystem.clone(), git, file_watch, event_sink);
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
                filesystem,
                browser,
                default_root,
                home_dir,
                hook_endpoint,
                main_webview_focus: Mutex::new(None),
                shim_root,
                shutdown_started: AtomicBool::new(false),
            });
            if let (Some(window_config), Some(profile_dir)) = (
                isolated_main_window.as_ref(),
                main_webview_data_dir.as_ref(),
            ) {
                std::fs::create_dir_all(profile_dir)
                    .map_err(|error| format!("create main WebView profile failed: {error}"))?;
                tauri::WebviewWindowBuilder::from_config(app, window_config)
                    .map_err(|error| format!("configure isolated main WebView failed: {error}"))?
                    .data_directory(profile_dir.clone())
                    .build()
                    .map_err(|error| format!("create isolated main WebView failed: {error}"))?;
            }
            #[cfg(feature = "e2e")]
            eprintln!(
                "[CCSM:E2E] registered WebView windows: {:?}",
                app.webview_windows().keys().collect::<Vec<_>>()
            );
            if let Some(main_window) = app.get_webview_window("main") {
                if let Some(main_webview) = app.get_webview("main") {
                    match MainWebviewFocusRestorer::start(&main_window, &main_webview) {
                        Ok(restorer) => {
                            if let Ok(mut slot) =
                                app.state::<DesktopState>().main_webview_focus.lock()
                            {
                                *slot = Some(restorer);
                            }
                        }
                        Err(error) => {
                            eprintln!("CCSM main WebView focus restorer unavailable: {error}")
                        }
                    }
                }
            } else {
                return Err("CCSM main WebView is unavailable after setup".into());
            }
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
            commands::cancel_directory_operation,
            commands::read_file,
            commands::resolve_file_reference,
            commands::write_file,
            commands::browse_host_directory,
            commands::create_host_directory,
            commands::cached_git,
            commands::refresh_git,
            commands::read_git_diff,
            commands::start_runtime,
            commands::write_runtime,
            commands::resize_runtime,
            commands::acknowledge_runtime_output,
            commands::stop_runtime,
            commands::create_browser,
            commands::set_browser_bounds,
            commands::set_browser_visible,
            commands::capture_browser,
            commands::focus_browser,
            commands::navigate_browser,
            commands::reload_browser,
            commands::close_browser,
            updates::check_update,
            updates::download_update,
            updates::install_update,
        ])
        .build(context)
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
    if cfg!(feature = "e2e") {
        ccsm_platform::cleanup_stale_runtime_shim_roots(data_dir);
        return data_dir.join(suffix);
    }
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
