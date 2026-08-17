use tauri::{Webview, WebviewWindow};

pub struct MainWebviewFocusRestorer {
    #[cfg(windows)]
    inner: windows::WindowsMainWebviewFocusRestorer,
}

impl MainWebviewFocusRestorer {
    pub fn start(window: &WebviewWindow, webview: &Webview) -> Result<Self, String> {
        #[cfg(windows)]
        {
            return windows::WindowsMainWebviewFocusRestorer::start(window, webview)
                .map(|inner| Self { inner });
        }
        #[cfg(not(windows))]
        {
            let _ = (window, webview);
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
        mem::{size_of, zeroed},
        ptr,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    };

    use tauri::{Webview, WebviewWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GUITHREADINFO, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
    };

    const FOCUS_POLL_INTERVAL: Duration = Duration::from_millis(25);

    pub struct WindowsMainWebviewFocusRestorer {
        shutdown: Arc<AtomicBool>,
        worker: Mutex<Option<thread::JoinHandle<()>>>,
    }

    impl WindowsMainWebviewFocusRestorer {
        pub fn start(window: &WebviewWindow, webview: &Webview) -> Result<Self, String> {
            let root_hwnd = window
                .hwnd()
                .map_err(|error| format!("resolve main window HWND failed: {error}"))?
                .0 as isize;
            let shutdown = Arc::new(AtomicBool::new(false));
            let worker_shutdown = Arc::clone(&shutdown);
            let webview = webview.clone();
            let worker = thread::Builder::new()
                .name("ccsm-main-webview-focus".into())
                .spawn(move || focus_loop(root_hwnd, webview, worker_shutdown))
                .map_err(|error| format!("start main WebView focus restorer failed: {error}"))?;
            Ok(Self {
                shutdown,
                worker: Mutex::new(Some(worker)),
            })
        }

        pub fn shutdown(&self) {
            self.shutdown.store(true, Ordering::Release);
            if let Ok(mut worker) = self.worker.lock()
                && let Some(worker) = worker.take()
            {
                let _ = worker.join();
            }
        }
    }

    fn focus_loop(root_hwnd: isize, webview: Webview, shutdown: Arc<AtomicBool>) {
        let mut failure_reported = false;
        while !shutdown.load(Ordering::Acquire) {
            if root_window_owns_unassigned_focus(root_hwnd) {
                match webview.set_focus() {
                    Ok(()) => failure_reported = false,
                    Err(error) if !failure_reported => {
                        failure_reported = true;
                        eprintln!("CCSM main WebView focus restore failed: {error}");
                    }
                    Err(_) => {}
                }
            } else {
                failure_reported = false;
            }
            thread::sleep(FOCUS_POLL_INTERVAL);
        }
    }

    fn root_window_owns_unassigned_focus(root_hwnd: isize) -> bool {
        let foreground_hwnd = unsafe { GetForegroundWindow() } as isize;
        if foreground_hwnd != root_hwnd {
            return false;
        }
        let thread_id = unsafe {
            GetWindowThreadProcessId(
                root_hwnd as windows_sys::Win32::Foundation::HWND,
                ptr::null_mut(),
            )
        };
        if thread_id == 0 {
            return false;
        }
        let mut info: GUITHREADINFO = unsafe { zeroed() };
        info.cbSize = size_of::<GUITHREADINFO>() as u32;
        if unsafe { GetGUIThreadInfo(thread_id, &mut info) } == 0 {
            return false;
        }
        should_restore_main_webview(root_hwnd, foreground_hwnd, info.hwndFocus as isize)
    }

    fn should_restore_main_webview(
        root_hwnd: isize,
        foreground_hwnd: isize,
        focused_hwnd: isize,
    ) -> bool {
        root_hwnd != 0 && foreground_hwnd == root_hwnd && focused_hwnd == root_hwnd
    }

    #[cfg(test)]
    mod tests {
        use super::should_restore_main_webview;

        #[test]
        fn restores_only_when_focus_is_stranded_on_the_foreground_root() {
            assert!(should_restore_main_webview(10, 10, 10));
            assert!(!should_restore_main_webview(10, 20, 10));
            assert!(!should_restore_main_webview(10, 10, 30));
            assert!(!should_restore_main_webview(0, 0, 0));
        }
    }
}
