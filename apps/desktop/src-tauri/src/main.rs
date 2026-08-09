fn main() {
    if let Some(provider) = ccsm_platform::provider_from_executable() {
        std::process::exit(ccsm_platform::run_cli_shim(provider));
    }
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.as_slice() == ["provider"] {
        let Some(provider) = ccsm_platform::provider_from_environment() else {
            eprintln!("ccsm provider mode requires CCSM_PROVIDER=claude|codex");
            std::process::exit(2);
        };
        std::process::exit(ccsm_platform::run_cli_shim(provider));
    }
    if arguments.as_slice() == ["hook", "report"] {
        std::process::exit(ccsm_platform::run_hook_reporter());
    }
    if let Err(error) = ccsm_platform::install_process_tree_guard() {
        eprintln!("CCSM process-tree containment failed: {error}");
        std::process::exit(1);
    }
    hide_standalone_console_window();
    ccsm_desktop::run();
}

#[cfg(windows)]
fn hide_standalone_console_window() {
    use windows_sys::Win32::{
        System::Console::{GetConsoleProcessList, GetConsoleWindow},
        UI::WindowsAndMessaging::{SW_HIDE, ShowWindow},
    };

    let mut process_ids = [0_u32; 2];
    let process_count =
        unsafe { GetConsoleProcessList(process_ids.as_mut_ptr(), process_ids.len() as u32) };
    if should_hide_standalone_console(process_count) {
        let window = unsafe { GetConsoleWindow() };
        if !window.is_null() {
            unsafe { ShowWindow(window, SW_HIDE) };
        }
    }
}

#[cfg(not(windows))]
fn hide_standalone_console_window() {}

fn should_hide_standalone_console(process_count: u32) -> bool {
    process_count == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_only_a_console_created_for_the_desktop_process() {
        assert!(should_hide_standalone_console(1));
        assert!(!should_hide_standalone_console(0));
        assert!(!should_hide_standalone_console(2));
    }
}
