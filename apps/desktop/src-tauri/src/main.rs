#[cfg(feature = "e2e")]
mod e2e_provider;
mod linux_renderer;

fn main() {
    if let Some(provider) = ccsm_platform::provider_from_executable() {
        std::process::exit(ccsm_platform::run_cli_shim(provider));
    }
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.as_slice() == ["provider"] {
        let Some(provider) = ccsm_platform::provider_from_environment() else {
            eprintln!("ccsm provider mode requires CCSM_PROVIDER=claude|codex|copilot");
            std::process::exit(2);
        };
        std::process::exit(ccsm_platform::run_cli_shim(provider));
    }
    if arguments.as_slice() == ["hook", "report"] {
        std::process::exit(ccsm_platform::run_hook_reporter());
    }
    #[cfg(feature = "e2e")]
    if e2e_provider::is_enabled() {
        std::process::exit(e2e_provider::run());
    }
    if let [mode, pgid] = arguments.as_slice()
        && mode == "process-watchdog"
    {
        let pgid = pgid.parse::<i32>().unwrap_or_default();
        std::process::exit(ccsm_platform::run_process_watchdog(pgid));
    }
    linux_renderer::configure_for_desktop();
    if let Err(error) = ccsm_platform::install_process_tree_guard() {
        eprintln!("CCSM process-tree containment failed: {error}");
        std::process::exit(1);
    }
    detach_standalone_console();
    ccsm_desktop::run();
}

#[cfg(windows)]
fn detach_standalone_console() {
    use windows_sys::Win32::System::Console::{FreeConsole, GetConsoleProcessList};

    let mut process_ids = [0_u32; 2];
    let process_count =
        unsafe { GetConsoleProcessList(process_ids.as_mut_ptr(), process_ids.len() as u32) };
    if should_detach_standalone_console(process_count) {
        unsafe { FreeConsole() };
    }
}

#[cfg(not(windows))]
fn detach_standalone_console() {}

#[cfg(any(windows, test))]
fn should_detach_standalone_console(process_count: u32) -> bool {
    process_count == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detaches_only_a_console_created_for_the_desktop_process() {
        assert!(should_detach_standalone_console(1));
        assert!(!should_detach_standalone_console(0));
        assert!(!should_detach_standalone_console(2));
    }
}
