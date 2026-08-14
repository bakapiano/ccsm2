use std::sync::Arc;

use tauri::WebviewWindow;

use crate::renderer_health::RendererHealthMonitor;

pub struct NativeRecoveryButton {
    #[cfg(windows)]
    inner: windows::WindowsRecoveryButton,
}

impl NativeRecoveryButton {
    pub fn start(
        main_window: &WebviewWindow,
        monitor: Arc<RendererHealthMonitor>,
        always_visible: bool,
    ) -> Result<Self, String> {
        #[cfg(windows)]
        {
            return windows::WindowsRecoveryButton::start(main_window, monitor, always_visible)
                .map(|inner| Self { inner });
        }
        #[cfg(not(windows))]
        {
            let _ = (main_window, monitor, always_visible);
            Ok(Self {})
        }
    }

    pub fn shutdown(&self) {
        #[cfg(windows)]
        self.inner.shutdown();
    }
}

#[cfg(windows)]
mod windows {
    use std::{
        mem::zeroed,
        ptr,
        sync::{Arc, Mutex, OnceLock, Weak, mpsc},
        thread,
        time::Duration,
    };

    use tauri::WebviewWindow;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{DEFAULT_GUI_FONT, GetStockObject},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::WindowsAndMessaging::{
            BN_CLICKED, BS_PUSHBUTTON, CreateWindowExW, DefWindowProcW, DestroyWindow,
            DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowRect, HMENU, KillTimer,
            MSG, PostQuitMessage, PostThreadMessageW, RegisterClassW, SW_HIDE, SW_SHOWNOACTIVATE,
            SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SendMessageW, SetTimer, SetWindowPos,
            ShowWindow, TranslateMessage, WM_CLOSE, WM_COMMAND, WM_DESTROY, WM_QUIT, WM_SETFONT,
            WM_TIMER, WNDCLASSW, WS_CHILD, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
        },
    };

    use crate::{native_input::NativeInputObserver, renderer_health::RendererHealthMonitor};

    const BUTTON_ID: u16 = 0xCC51;
    const TIMER_ID: usize = 1;
    const BUTTON_WIDTH: i32 = 112;
    const BUTTON_HEIGHT: i32 = 32;
    const RIGHT_MARGIN: i32 = 16;
    const BOTTOM_MARGIN: i32 = 44;
    const CLASS_NAME: &str = "CCSMRendererRecoveryButtonWindow";

    struct ButtonContext {
        root_hwnd: isize,
        always_visible: bool,
        monitor: Weak<RendererHealthMonitor>,
    }

    static BUTTON_CONTEXT: OnceLock<Mutex<Option<ButtonContext>>> = OnceLock::new();

    pub struct WindowsRecoveryButton {
        thread_id: u32,
        worker: Mutex<Option<thread::JoinHandle<()>>>,
    }

    impl WindowsRecoveryButton {
        pub fn start(
            main_window: &WebviewWindow,
            monitor: Arc<RendererHealthMonitor>,
            always_visible: bool,
        ) -> Result<Self, String> {
            let root_hwnd = main_window
                .hwnd()
                .map_err(|error| format!("resolve main window HWND failed: {error}"))?
                .0 as isize;
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let worker = thread::Builder::new()
                .name("ccsm-native-reload-button".into())
                .spawn(move || {
                    run_button_thread(
                        root_hwnd,
                        Arc::downgrade(&monitor),
                        always_visible,
                        ready_tx,
                    )
                })
                .map_err(|error| format!("start native reload button failed: {error}"))?;
            let thread_id = ready_rx
                .recv_timeout(Duration::from_secs(5))
                .map_err(|error| format!("native reload button startup timed out: {error}"))??;
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

    fn run_button_thread(
        root_hwnd: isize,
        monitor: Weak<RendererHealthMonitor>,
        always_visible: bool,
        ready: mpsc::SyncSender<Result<u32, String>>,
    ) {
        let context = BUTTON_CONTEXT.get_or_init(|| Mutex::new(None));
        if let Ok(mut slot) = context.lock() {
            *slot = Some(ButtonContext {
                root_hwnd,
                always_visible,
                monitor,
            });
        }
        let thread_id = unsafe { GetCurrentThreadId() };
        let class_name = wide(CLASS_NAME);
        let button_class = wide("BUTTON");
        let button_text = wide("Reload UI");
        let instance = unsafe { GetModuleHandleW(ptr::null()) };
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: class_name.as_ptr(),
            ..unsafe { zeroed() }
        };
        if unsafe { RegisterClassW(&window_class) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(1410) {
                let _ = ready.send(Err(format!("register native reload class failed: {error}")));
                clear_context();
                return;
            }
        }
        let overlay = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class_name.as_ptr(),
                ptr::null(),
                WS_POPUP,
                0,
                0,
                BUTTON_WIDTH,
                BUTTON_HEIGHT,
                root_hwnd as HWND,
                ptr::null_mut(),
                instance,
                ptr::null(),
            )
        };
        if overlay.is_null() {
            let _ = ready.send(Err(format!(
                "create native reload overlay failed: {}",
                std::io::Error::last_os_error()
            )));
            clear_context();
            return;
        }
        let button = unsafe {
            CreateWindowExW(
                0,
                button_class.as_ptr(),
                button_text.as_ptr(),
                WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
                0,
                0,
                BUTTON_WIDTH,
                BUTTON_HEIGHT,
                overlay,
                BUTTON_ID as usize as HMENU,
                instance,
                ptr::null(),
            )
        };
        if button.is_null() {
            unsafe {
                DestroyWindow(overlay);
            }
            let _ = ready.send(Err(format!(
                "create native reload button failed: {}",
                std::io::Error::last_os_error()
            )));
            clear_context();
            return;
        }
        let font = unsafe { GetStockObject(DEFAULT_GUI_FONT) };
        unsafe {
            SendMessageW(button, WM_SETFONT, font as WPARAM, 1);
            SetTimer(overlay, TIMER_ID, 200, None);
        }
        let _ = ready.send(Ok(thread_id));
        let mut message: MSG = unsafe { zeroed() };
        while unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } > 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        unsafe {
            KillTimer(overlay, TIMER_ID);
            DestroyWindow(overlay);
        }
        clear_context();
    }

    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_TIMER if wparam == TIMER_ID => {
                update_button_position(window);
                0
            }
            WM_COMMAND
                if low_word(wparam) == BUTTON_ID && high_word(wparam) == BN_CLICKED as u16 =>
            {
                if let Some(monitor) = current_monitor() {
                    if let Err(error) = monitor.request_manual_recovery() {
                        eprintln!("CCSM manual renderer recovery failed: {error}");
                    }
                }
                0
            }
            WM_CLOSE => {
                unsafe { DestroyWindow(window) };
                0
            }
            WM_DESTROY => {
                unsafe { PostQuitMessage(0) };
                0
            }
            _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
        }
    }

    fn update_button_position(window: HWND) {
        let Some((root, monitor, always_visible)) = BUTTON_CONTEXT
            .get()
            .and_then(|context| context.lock().ok())
            .and_then(|context| {
                let context = context.as_ref()?;
                Some((
                    context.root_hwnd as HWND,
                    context.monitor.upgrade()?,
                    context.always_visible,
                ))
            })
        else {
            unsafe { ShowWindow(window, SW_HIDE) };
            return;
        };
        if !monitor.manual_button_window_visible()
            || (!always_visible && !recovery_button_owner_is_foreground(window, root, &monitor))
        {
            unsafe { ShowWindow(window, SW_HIDE) };
            return;
        }
        let mut rect: RECT = unsafe { zeroed() };
        if unsafe { GetWindowRect(root, &mut rect) } == 0 {
            unsafe { ShowWindow(window, SW_HIDE) };
            return;
        }
        let x = rect.right - BUTTON_WIDTH - RIGHT_MARGIN;
        let y = rect.bottom - BUTTON_HEIGHT - BOTTOM_MARGIN;
        unsafe {
            SetWindowPos(
                window,
                ptr::null_mut(),
                x,
                y,
                BUTTON_WIDTH,
                BUTTON_HEIGHT,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
            );
            ShowWindow(window, SW_SHOWNOACTIVATE);
        }
    }

    fn recovery_button_owner_is_foreground(
        window: HWND,
        root: HWND,
        monitor: &RendererHealthMonitor,
    ) -> bool {
        let foreground = unsafe { GetForegroundWindow() };
        foreground == root
            || foreground == window
            || NativeInputObserver::main_webview_is_foreground(monitor)
    }

    fn current_monitor() -> Option<Arc<RendererHealthMonitor>> {
        BUTTON_CONTEXT
            .get()
            .and_then(|context| context.lock().ok())
            .and_then(|context| context.as_ref()?.monitor.upgrade())
    }

    fn clear_context() {
        if let Some(context) = BUTTON_CONTEXT.get()
            && let Ok(mut slot) = context.lock()
        {
            *slot = None;
        }
    }

    fn low_word(value: usize) -> u16 {
        (value & u16::MAX as usize) as u16
    }

    fn high_word(value: usize) -> u16 {
        ((value >> 16) & u16::MAX as usize) as u16
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}
