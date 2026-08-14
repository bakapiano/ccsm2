#[cfg(target_os = "linux")]
use std::{env, path::Path};

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxRendererMode {
    Auto,
    D3d12,
    Software,
    System,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxRendererBackend {
    D3d12,
    Software,
    System,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy)]
struct LinuxRendererFacts {
    is_wsl: bool,
    has_dxg: bool,
    has_d3d12_runtime: bool,
    has_mesa_d3d12_driver: bool,
    has_renderer_override: bool,
}

#[cfg(any(target_os = "linux", test))]
impl LinuxRendererFacts {
    fn wsl_d3d12_available(self) -> bool {
        self.is_wsl && self.has_dxg && self.has_d3d12_runtime && self.has_mesa_d3d12_driver
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy)]
struct LinuxRendererSelection {
    mode: LinuxRendererMode,
    backend: LinuxRendererBackend,
    invalid_mode: bool,
    reason: &'static str,
}

pub fn configure_for_desktop() {
    #[cfg(target_os = "linux")]
    configure_linux_renderer();
}

#[cfg(any(target_os = "linux", test))]
fn select_linux_renderer(
    requested_mode: Option<&str>,
    facts: LinuxRendererFacts,
) -> LinuxRendererSelection {
    let (mode, invalid_mode) = parse_mode(requested_mode);
    let (backend, reason) = match mode {
        LinuxRendererMode::D3d12 => (
            LinuxRendererBackend::D3d12,
            "CCSM_LINUX_RENDERER requested Mesa D3D12",
        ),
        LinuxRendererMode::Software => (
            LinuxRendererBackend::Software,
            "CCSM_LINUX_RENDERER requested WebKit software compositing",
        ),
        LinuxRendererMode::System => (
            LinuxRendererBackend::System,
            "CCSM_LINUX_RENDERER selected the system renderer",
        ),
        LinuxRendererMode::Auto if facts.has_renderer_override => (
            LinuxRendererBackend::System,
            "an existing Mesa or WebKit renderer override is active",
        ),
        LinuxRendererMode::Auto if facts.wsl_d3d12_available() => (
            LinuxRendererBackend::D3d12,
            "WSLg D3D12 prerequisites are available",
        ),
        LinuxRendererMode::Auto if facts.is_wsl => (
            LinuxRendererBackend::Software,
            "WSLg D3D12 prerequisites are incomplete",
        ),
        LinuxRendererMode::Auto => (
            LinuxRendererBackend::System,
            "the native Linux graphics stack owns renderer selection",
        ),
    };
    LinuxRendererSelection {
        mode,
        backend,
        invalid_mode,
        reason,
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_mode(value: Option<&str>) -> (LinuxRendererMode, bool) {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("auto") => (LinuxRendererMode::Auto, false),
        Some("d3d12") => (LinuxRendererMode::D3d12, false),
        Some("software") => (LinuxRendererMode::Software, false),
        Some("system") => (LinuxRendererMode::System, false),
        Some(_) => (LinuxRendererMode::Auto, true),
    }
}

#[cfg(target_os = "linux")]
fn configure_linux_renderer() {
    let requested_mode = env::var("CCSM_LINUX_RENDERER")
        .ok()
        .map(|value| value.to_ascii_lowercase());
    let facts = detect_linux_renderer_facts();
    let selection = select_linux_renderer(requested_mode.as_deref(), facts);
    if selection.invalid_mode {
        eprintln!(
            "CCSM Linux renderer: unknown CCSM_LINUX_RENDERER value {:?}; using auto",
            requested_mode.as_deref().unwrap_or_default()
        );
    }

    match selection.backend {
        LinuxRendererBackend::D3d12 => {
            // SAFETY: the desktop entry point calls this before Tauri/WebKit
            // initialization, while the process is still single-threaded.
            unsafe { env::set_var("GALLIUM_DRIVER", "d3d12") };
        }
        LinuxRendererBackend::Software => {
            // SAFETY: the desktop entry point calls this before Tauri/WebKit
            // initialization, while the process is still single-threaded.
            unsafe { env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
        }
        LinuxRendererBackend::System => {}
    }
    eprintln!(
        "CCSM Linux renderer: {} ({:?}; {})",
        backend_name(selection.backend),
        selection.mode,
        selection.reason
    );
}

#[cfg(target_os = "linux")]
fn detect_linux_renderer_facts() -> LinuxRendererFacts {
    let is_wsl = env_var_present("WSL_DISTRO_NAME")
        || env_var_present("WSL_INTEROP")
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|value| value.to_ascii_lowercase().contains("microsoft"));
    LinuxRendererFacts {
        is_wsl,
        has_dxg: Path::new("/dev/dxg").exists(),
        has_d3d12_runtime: Path::new("/usr/lib/wsl/lib/libd3d12.so").exists(),
        has_mesa_d3d12_driver: mesa_d3d12_driver_available(),
        has_renderer_override: [
            "GALLIUM_DRIVER",
            "MESA_LOADER_DRIVER_OVERRIDE",
            "LIBGL_ALWAYS_SOFTWARE",
            "WEBKIT_DISABLE_COMPOSITING_MODE",
            "WEBKIT_FORCE_COMPOSITING_MODE",
        ]
        .into_iter()
        .any(env_var_present),
    }
}

#[cfg(target_os = "linux")]
fn mesa_d3d12_driver_available() -> bool {
    [
        "/usr/lib/x86_64-linux-gnu/dri/d3d12_dri.so",
        "/usr/lib/aarch64-linux-gnu/dri/d3d12_dri.so",
        "/usr/lib64/dri/d3d12_dri.so",
        "/usr/lib/dri/d3d12_dri.so",
    ]
    .into_iter()
    .any(|path| Path::new(path).exists())
}

#[cfg(target_os = "linux")]
fn env_var_present(name: &str) -> bool {
    env::var_os(name).is_some_and(|value| !value.is_empty())
}

#[cfg(target_os = "linux")]
fn backend_name(backend: LinuxRendererBackend) -> &'static str {
    match backend {
        LinuxRendererBackend::D3d12 => "d3d12",
        LinuxRendererBackend::Software => "software",
        LinuxRendererBackend::System => "system",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl_facts() -> LinuxRendererFacts {
        LinuxRendererFacts {
            is_wsl: true,
            has_dxg: true,
            has_d3d12_runtime: true,
            has_mesa_d3d12_driver: true,
            has_renderer_override: false,
        }
    }

    #[test]
    fn auto_selects_d3d12_for_a_complete_wslg_stack() {
        let selection = select_linux_renderer(None, wsl_facts());

        assert_eq!(selection.mode, LinuxRendererMode::Auto);
        assert_eq!(selection.backend, LinuxRendererBackend::D3d12);
        assert!(selection.reason.contains("D3D12"));
    }

    #[test]
    fn auto_uses_software_compositing_for_an_incomplete_wslg_stack() {
        let selection = select_linux_renderer(
            Some("auto"),
            LinuxRendererFacts {
                has_mesa_d3d12_driver: false,
                ..wsl_facts()
            },
        );

        assert_eq!(selection.backend, LinuxRendererBackend::Software);
    }

    #[test]
    fn auto_preserves_user_renderer_overrides() {
        let selection = select_linux_renderer(
            None,
            LinuxRendererFacts {
                has_renderer_override: true,
                ..wsl_facts()
            },
        );

        assert_eq!(selection.backend, LinuxRendererBackend::System);
    }

    #[test]
    fn native_linux_uses_the_system_graphics_stack() {
        let selection = select_linux_renderer(
            None,
            LinuxRendererFacts {
                is_wsl: false,
                has_dxg: false,
                has_d3d12_runtime: false,
                has_mesa_d3d12_driver: false,
                has_renderer_override: false,
            },
        );

        assert_eq!(selection.backend, LinuxRendererBackend::System);
    }

    #[test]
    fn explicit_modes_select_the_requested_backend() {
        assert_eq!(
            select_linux_renderer(Some("d3d12"), wsl_facts()).backend,
            LinuxRendererBackend::D3d12
        );
        assert_eq!(
            select_linux_renderer(Some("software"), wsl_facts()).backend,
            LinuxRendererBackend::Software
        );
        assert_eq!(
            select_linux_renderer(Some("system"), wsl_facts()).backend,
            LinuxRendererBackend::System
        );
    }

    #[test]
    fn unknown_mode_uses_auto_selection_and_reports_the_input() {
        let selection = select_linux_renderer(Some("fastest"), wsl_facts());

        assert!(selection.invalid_mode);
        assert_eq!(selection.mode, LinuxRendererMode::Auto);
        assert_eq!(selection.backend, LinuxRendererBackend::D3d12);
    }
}
