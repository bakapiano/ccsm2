#![cfg(windows)]

use std::{
    env,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, mpsc},
    time::Duration,
};

use ccsm_core::dto::ProviderKind;
use ccsm_platform::{HookReportSink, LocalHookEndpoint};

fn powershell_hook_command(reporter: &Path) -> String {
    let reporter = reporter.to_string_lossy().replace('\'', "''");
    format!("& '{reporter}' hook report")
}

#[test]
fn powershell_launches_the_real_reporter_and_delivers_to_the_named_pipe() {
    let (report_tx, report_rx) = mpsc::channel();
    let sink: HookReportSink = Arc::new(move |report| {
        report_tx.send(report).unwrap();
    });
    let endpoint = LocalHookEndpoint::start(sink).unwrap();
    let reporter = env::var_os("CCSM_SMOKE_REPORTER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_ccsm-desktop")));

    let mut child = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &powershell_hook_command(&reporter),
        ])
        .env("CCSM_PROVIDER", "codex")
        .env("CCSM_SESSION_ID", "smoke-cli-session")
        .env("CCSM_RUNTIME_ID", "smoke-runtime")
        .env("CCSM_HOOK_TOKEN", "smoke-token")
        .env("CCSM_HOOK_PIPE", endpoint.address())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"session_id":"smoke-native-session","hook_event_name":"SessionStart"}"#)
        .unwrap();

    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "{}\n");

    let report = report_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(report.provider, ProviderKind::Codex);
    assert_eq!(report.cli_session_id, "smoke-cli-session");
    assert_eq!(report.runtime_id, "smoke-runtime");
    assert_eq!(report.token, "smoke-token");
    assert_eq!(report.native_session_id, "smoke-native-session");
    assert_eq!(report.hook_event_name, "SessionStart");
}
