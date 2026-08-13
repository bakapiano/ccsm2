use std::sync::Arc;

use tauri::{Webview, WebviewWindow};

use crate::renderer_health::RendererHealthMonitor;

pub struct NativeInputObserver {
    #[cfg(windows)]
    inner: windows::WindowsNativeInputObserver,
}

impl NativeInputObserver {
    pub fn start(
        window: &WebviewWindow,
        monitor: Arc<RendererHealthMonitor>,
    ) -> Result<Self, String> {
        #[cfg(windows)]
        {
            return windows::WindowsNativeInputObserver::start(window, monitor)
                .map(|inner| Self { inner });
        }
        #[cfg(not(windows))]
        {
            let _ = (window, monitor);
            Ok(Self {})
        }
    }

    pub fn shutdown(&self) {
        #[cfg(windows)]
        self.inner.shutdown();
    }

    pub fn bind_main_webview(webview: &Webview) -> Result<(), String> {
        #[cfg(windows)]
        return windows::bind_main_webview(webview);
        #[cfg(not(windows))]
        {
            let _ = webview;
            Ok(())
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::{
        mem::zeroed,
        ptr,
        sync::{Arc, Mutex, OnceLock, Weak, mpsc},
        thread,
    };

    use tauri::{Webview, WebviewWindow};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::ScreenToClient,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::GetCurrentThreadId,
        },
        UI::WindowsAndMessaging::{
            CallNextHookEx, GetClientRect, GetMessageW, GetWindowThreadProcessId, MSLLHOOKSTRUCT,
            PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL, WM_LBUTTONUP,
            WM_QUIT, WindowFromPoint,
        },
    };

    use crate::renderer_health::RendererHealthMonitor;

    const TITLEBAR_HEIGHT_PX: i32 = 35;

    struct HookContext {
        root_hwnd: isize,
        main_browser_pid: Option<u32>,
        monitor: Weak<RendererHealthMonitor>,
    }

    static HOOK_CONTEXT: OnceLock<Mutex<Option<HookContext>>> = OnceLock::new();

    pub struct WindowsNativeInputObserver {
        thread_id: u32,
        worker: Mutex<Option<thread::JoinHandle<()>>>,
    }

    impl WindowsNativeInputObserver {
        pub fn start(
            window: &WebviewWindow,
            monitor: Arc<RendererHealthMonitor>,
        ) -> Result<Self, String> {
            let root_hwnd = window
                .hwnd()
                .map_err(|error| format!("resolve main window HWND failed: {error}"))?
                .0 as isize;
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let worker = thread::Builder::new()
                .name("ccsm-native-input".into())
                .spawn(move || {
                    let thread_id = unsafe { GetCurrentThreadId() };
                    let context = HOOK_CONTEXT.get_or_init(|| Mutex::new(None));
                    if let Ok(mut slot) = context.lock() {
                        *slot = Some(HookContext {
                            root_hwnd,
                            main_browser_pid: None,
                            monitor: Arc::downgrade(&monitor),
                        });
                    }
                    let hook = unsafe {
                        SetWindowsHookExW(
                            WH_MOUSE_LL,
                            Some(low_level_mouse_proc),
                            ptr::null_mut(),
                            0,
                        )
                    };
                    if hook.is_null() {
                        let _ = ready_tx.send(Err(format!(
                            "install low-level mouse hook failed: {}",
                            std::io::Error::last_os_error()
                        )));
                        clear_context();
                        return;
                    }
                    let _ = ready_tx.send(Ok(thread_id));
                    let mut message = unsafe { zeroed() };
                    while unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } > 0 {}
                    unsafe {
                        UnhookWindowsHookEx(hook);
                    }
                    clear_context();
                })
                .map_err(|error| format!("start native input observer failed: {error}"))?;
            let thread_id = ready_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|error| format!("native input observer startup timed out: {error}"))??;
            Ok(Self {
                thread_id,
                worker: Mutex::new(Some(worker)),
            })
        }

        pub fn shutdown(&self) {
            unsafe {
                PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
            }
            if let Ok(mut worker) = self.worker.lock()
                && let Some(worker) = worker.take()
            {
                let _ = worker.join();
            }
        }
    }

    unsafe extern "system" fn low_level_mouse_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 && wparam as u32 == WM_LBUTTONUP {
            let event = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
            let (monitor, targets_main_webview) = HOOK_CONTEXT
                .get()
                .and_then(|context| context.lock().ok())
                .and_then(|context| {
                    let context = context.as_ref()?;
                    Some((
                        context.monitor.upgrade()?,
                        click_targets_main_webview(event.pt, context),
                    ))
                })
                .map(|value| (Some(value.0), value.1))
                .unwrap_or((None, false));
            if let Some(monitor) = monitor {
                monitor.note_native_input_event(targets_main_webview);
                if targets_main_webview {
                    let _ = monitor.observe_native_click(false);
                }
            }
        }
        unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) }
    }

    fn click_targets_main_webview(mut point: POINT, context: &HookContext) -> bool {
        let Some(main_browser_pid) = context.main_browser_pid else {
            return false;
        };
        let target = unsafe { WindowFromPoint(point) };
        if target.is_null() {
            return false;
        }
        let mut target_pid = 0;
        unsafe {
            GetWindowThreadProcessId(target, &mut target_pid);
        }
        if target_pid == 0 || !process_descends_from(target_pid, main_browser_pid) {
            return false;
        }
        let root = context.root_hwnd as windows_sys::Win32::Foundation::HWND;
        if unsafe { ScreenToClient(root, &mut point) } == 0 {
            return false;
        }
        let mut client: RECT = unsafe { zeroed() };
        if unsafe { GetClientRect(root, &mut client) } == 0 {
            return false;
        }
        point.x >= client.left
            && point.x < client.right
            && point.y >= TITLEBAR_HEIGHT_PX
            && point.y < client.bottom
    }

    pub fn bind_main_webview(webview: &Webview) -> Result<(), String> {
        webview
            .with_webview(|webview| {
                let controller = webview.controller();
                let Ok(browser) = (unsafe { controller.CoreWebView2() }) else {
                    return;
                };
                let mut browser_pid = 0;
                if unsafe { browser.BrowserProcessId(&mut browser_pid) }.is_ok()
                    && let Some(context) = HOOK_CONTEXT.get()
                    && let Ok(mut context) = context.lock()
                    && let Some(context) = context.as_mut()
                {
                    context.main_browser_pid = Some(browser_pid);
                    if let Some(monitor) = context.monitor.upgrade() {
                        monitor.set_native_main_browser_pid(browser_pid);
                    }
                }
            })
            .map_err(|error| format!("bind main WebView process failed: {error}"))
    }

    fn process_descends_from(mut process_id: u32, ancestor_id: u32) -> bool {
        for _ in 0..16 {
            if process_id == ancestor_id {
                return true;
            }
            let Some(parent) = parent_process_id(process_id) else {
                return false;
            };
            if parent == 0 || parent == process_id {
                return false;
            }
            process_id = parent;
        }
        false
    }

    fn parent_process_id(process_id: u32) -> Option<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
            loop {
                if entry.th32ProcessID == process_id {
                    found = Some(entry.th32ParentProcessID);
                    break;
                }
                if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                    break;
                }
            }
        }
        unsafe {
            CloseHandle(snapshot);
        }
        found
    }

    fn clear_context() {
        if let Some(context) = HOOK_CONTEXT.get()
            && let Ok(mut slot) = context.lock()
        {
            *slot = None;
        }
    }
}
