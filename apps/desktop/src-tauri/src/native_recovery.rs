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
        time::{Duration, Instant},
    };

    use tauri::WebviewWindow;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{ClientToScreen, DEFAULT_GUI_FONT, GetStockObject},
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::WindowsAndMessaging::{
            BN_CLICKED, BS_PUSHBUTTON, CreateWindowExW, DefWindowProcW, DestroyWindow,
            DispatchMessageW, GUI_INMOVESIZE, GUITHREADINFO, GW_OWNER, GWLP_HWNDPARENT,
            GetClientRect, GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetWindow,
            GetWindowThreadProcessId, HMENU, IsIconic, IsWindowVisible, KillTimer, MSG,
            PostQuitMessage, PostThreadMessageW, RegisterClassW, SW_HIDE, SW_SHOWNOACTIVATE,
            SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SendMessageW, SetTimer,
            SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, WM_CLOSE, WM_COMMAND,
            WM_DESTROY, WM_QUIT, WM_SETFONT, WM_TIMER, WNDCLASSW, WS_CHILD, WS_EX_TOOLWINDOW,
            WS_POPUP, WS_VISIBLE,
        },
    };

    use crate::{native_input::NativeInputObserver, renderer_health::RendererHealthMonitor};

    const BUTTON_ID: u16 = 0xCC51;
    const TIMER_ID: usize = 1;
    const BUTTON_WIDTH: i32 = 78;
    const BUTTON_HEIGHT: i32 = 20;
    const STATUS_BAR_RIGHT_INSET: i32 = 2;
    const STATUS_BAR_BOTTOM_INSET: i32 = 1;
    const POSITION_TIMER_MS: u32 = 50;
    const RESTORE_ANIMATION_DELAY_MS: u64 = 320;
    const GEOMETRY_ANIMATION_DELAY_MS: u64 = 220;
    const MOVE_END_DELAY_MS: u64 = 50;
    const CLASS_NAME: &str = "CCSMRendererRecoveryButtonWindow";

    struct ButtonContext {
        root_hwnd: isize,
        always_visible: bool,
        monitor: Weak<RendererHealthMonitor>,
        presentation: OverlayPresentation,
    }

    struct OverlayPresentation {
        was_unavailable: bool,
        was_moving: bool,
        last_rect: Option<ScreenRect>,
        show_after: Instant,
    }

    impl OverlayPresentation {
        fn new() -> Self {
            Self {
                was_unavailable: true,
                was_moving: false,
                last_rect: None,
                show_after: Instant::now(),
            }
        }

        fn update(&mut self, presentation: RootPresentation, now: Instant) -> Option<ScreenRect> {
            match presentation {
                RootPresentation::Unavailable => {
                    self.was_unavailable = true;
                    self.was_moving = false;
                    self.last_rect = None;
                    None
                }
                RootPresentation::Moving => {
                    self.was_moving = true;
                    self.last_rect = None;
                    None
                }
                RootPresentation::Ready(rect) => {
                    if self.was_unavailable {
                        self.was_unavailable = false;
                        self.was_moving = false;
                        self.show_after = now + Duration::from_millis(RESTORE_ANIMATION_DELAY_MS);
                    } else if self.was_moving {
                        self.was_moving = false;
                        self.show_after = now + Duration::from_millis(MOVE_END_DELAY_MS);
                    } else if self.last_rect.is_some_and(|previous| previous != rect) {
                        self.show_after = now + Duration::from_millis(GEOMETRY_ANIMATION_DELAY_MS);
                    }
                    self.last_rect = Some(rect);
                    (now >= self.show_after).then_some(rect)
                }
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct ScreenRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    enum RootPresentation {
        Unavailable,
        Moving,
        Ready(ScreenRect),
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
                presentation: OverlayPresentation::new(),
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
                ptr::null_mut(),
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
            SetTimer(overlay, TIMER_ID, POSITION_TIMER_MS, None);
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
            hide_overlay(window);
            return;
        };
        // Keep this timer on Win32-only reads. Tauri window getters wait for the main event-loop
        // thread and can deadlock with synchronous owned-window messages during move/size loops.
        let Some(rect) = update_presentation(root) else {
            hide_overlay(window);
            return;
        };
        if !always_visible && !recovery_button_owner_is_foreground(window, root, &monitor) {
            hide_overlay(window);
            return;
        }
        let x = rect.right - BUTTON_WIDTH - STATUS_BAR_RIGHT_INSET;
        let y = rect.bottom - BUTTON_HEIGHT - STATUS_BAR_BOTTOM_INSET;
        unsafe {
            if GetWindow(window, GW_OWNER) != root {
                SetWindowLongPtrW(window, GWLP_HWNDPARENT, root as isize);
            }
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

    fn hide_overlay(window: HWND) {
        unsafe {
            ShowWindow(window, SW_HIDE);
            if !GetWindow(window, GW_OWNER).is_null() {
                SetWindowLongPtrW(window, GWLP_HWNDPARENT, 0);
            }
        }
    }

    fn update_presentation(root: HWND) -> Option<ScreenRect> {
        let presentation = root_presentation(root);
        let now = Instant::now();
        let mut context = BUTTON_CONTEXT.get()?.lock().ok()?;
        let state = &mut context.as_mut()?.presentation;
        state.update(presentation, now)
    }

    fn root_presentation(root: HWND) -> RootPresentation {
        if unsafe { IsWindowVisible(root) } == 0 || unsafe { IsIconic(root) } != 0 {
            return RootPresentation::Unavailable;
        }
        let root_thread_id = unsafe { GetWindowThreadProcessId(root, ptr::null_mut()) };
        if root_thread_id == 0 {
            return RootPresentation::Unavailable;
        }
        let mut thread_info: GUITHREADINFO = unsafe { zeroed() };
        thread_info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        if unsafe { GetGUIThreadInfo(root_thread_id, &mut thread_info) } == 0 {
            return RootPresentation::Unavailable;
        }
        if thread_info.flags & GUI_INMOVESIZE != 0 {
            return RootPresentation::Moving;
        }
        let mut client_rect: RECT = unsafe { zeroed() };
        if unsafe { GetClientRect(root, &mut client_rect) } == 0 {
            return RootPresentation::Unavailable;
        }
        let mut top_left = POINT {
            x: client_rect.left,
            y: client_rect.top,
        };
        let mut bottom_right = POINT {
            x: client_rect.right,
            y: client_rect.bottom,
        };
        if unsafe { ClientToScreen(root, &mut top_left) } == 0
            || unsafe { ClientToScreen(root, &mut bottom_right) } == 0
        {
            return RootPresentation::Unavailable;
        }
        RootPresentation::Ready(ScreenRect {
            left: top_left.x,
            top: top_left.y,
            right: bottom_right.x,
            bottom: bottom_right.y,
        })
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

    #[cfg(test)]
    mod tests {
        use super::*;

        fn rect(left: i32, top: i32) -> ScreenRect {
            ScreenRect {
                left,
                top,
                right: left + 1_320,
                bottom: top + 800,
            }
        }

        #[test]
        fn restore_waits_for_the_window_animation() {
            let now = Instant::now();
            let target = rect(0, 0);
            let mut state = OverlayPresentation::new();

            assert_eq!(state.update(RootPresentation::Ready(target), now), None);
            assert_eq!(
                state.update(
                    RootPresentation::Ready(target),
                    now + Duration::from_millis(RESTORE_ANIMATION_DELAY_MS - 1),
                ),
                None
            );
            assert_eq!(
                state.update(
                    RootPresentation::Ready(target),
                    now + Duration::from_millis(RESTORE_ANIMATION_DELAY_MS),
                ),
                Some(target)
            );
        }

        #[test]
        fn move_hides_then_returns_at_the_final_position() {
            let now = Instant::now();
            let original = rect(0, 0);
            let moved = rect(60, 40);
            let mut state = OverlayPresentation::new();
            state.was_unavailable = false;
            state.last_rect = Some(original);

            assert_eq!(state.update(RootPresentation::Moving, now), None);
            assert_eq!(state.update(RootPresentation::Ready(moved), now), None);
            assert_eq!(
                state.update(
                    RootPresentation::Ready(moved),
                    now + Duration::from_millis(MOVE_END_DELAY_MS),
                ),
                Some(moved)
            );
        }

        #[test]
        fn geometry_change_waits_for_visual_settling() {
            let now = Instant::now();
            let original = rect(0, 0);
            let maximized = rect(-8, -8);
            let mut state = OverlayPresentation::new();
            state.was_unavailable = false;
            state.last_rect = Some(original);

            assert_eq!(state.update(RootPresentation::Ready(maximized), now), None);
            assert_eq!(
                state.update(
                    RootPresentation::Ready(maximized),
                    now + Duration::from_millis(GEOMETRY_ANIMATION_DELAY_MS),
                ),
                Some(maximized)
            );
        }
    }
}
