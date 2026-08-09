use std::{sync::Arc, time::Duration};

use ccsm_core::{
    dto::ProviderKind,
    ports::{PtyBackend, PtyEvent, PtySpawnSpec},
};
use ccsm_platform::PortablePtyBackend;

#[test]
fn stopping_a_pty_reports_exit_without_waiting_for_app_shutdown() {
    let directory = tempfile::tempdir().unwrap();
    let backend = PortablePtyBackend::new(
        directory.path().join("shims"),
        std::env::current_exe().unwrap(),
    )
    .unwrap()
    .with_claude_overrides(None, None, None);
    let (tx, rx) = std::sync::mpsc::channel();
    let process = backend
        .spawn(
            PtySpawnSpec {
                cwd: directory.path().to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                provider: ProviderKind::Shell,
                native_session_id: None,
                hook: None,
            },
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();

    process.stop().unwrap();
    process.shutdown().unwrap();
    loop {
        match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            PtyEvent::Exit(_) => break,
            PtyEvent::Output(_) | PtyEvent::Error(_) => {}
        }
    }
}

#[test]
fn short_lived_pty_delivers_output_before_exit() {
    let directory = tempfile::tempdir().unwrap();
    let backend = PortablePtyBackend::new(
        directory.path().join("shims"),
        std::env::current_exe().unwrap(),
    )
    .unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let process = backend
        .spawn(
            PtySpawnSpec {
                cwd: directory.path().to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                provider: ProviderKind::Shell,
                native_session_id: None,
                hook: None,
            },
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();

    let mut output = Vec::new();
    #[cfg(windows)]
    let command = b"Write-Output ccsm-before-exit; exit 7\r\n".to_vec();
    #[cfg(not(windows))]
    let command = b"echo ccsm-before-exit; exit 7\n".to_vec();
    loop {
        match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            PtyEvent::Output(data) => {
                let cursor_query = data.windows(4).any(|window| window == b"\x1b[6n");
                output.extend(data);
                if cursor_query {
                    process.write(b"\x1b[1;1R".to_vec()).unwrap();
                    continue;
                }
                break;
            }
            PtyEvent::Error(_) => {}
            PtyEvent::Exit(code) => panic!("PTY exited before accepting input: {code}"),
        }
    }
    process.write(command).unwrap();
    let exit_code = loop {
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| {
                panic!(
                    "timed out waiting for PTY Exit ({error}); output={:?}",
                    String::from_utf8_lossy(&output)
                )
            });
        match event {
            PtyEvent::Output(data) => output.extend(data),
            PtyEvent::Error(_) => {}
            PtyEvent::Exit(code) => break code,
        }
    };

    assert_eq!(exit_code, 7);
    assert!(
        String::from_utf8_lossy(&output).contains("ccsm-before-exit"),
        "PTY output was not drained before Exit"
    );
}
