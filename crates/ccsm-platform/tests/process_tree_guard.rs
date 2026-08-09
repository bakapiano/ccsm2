#![cfg(windows)]

use std::{
    env,
    os::windows::process::CommandExt,
    process::Command,
    thread,
    time::{Duration, Instant},
};

use ccsm_platform::install_process_tree_guard;
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0},
    System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    },
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const HELPER_ENV: &str = "CCSM_PROCESS_TREE_GUARD_HELPER";
const LEAF_ENV: &str = "CCSM_PROCESS_TREE_GUARD_LEAF";
const PID_FILE_ENV: &str = "CCSM_PROCESS_TREE_GUARD_PID_FILE";

#[test]
fn process_tree_guard_leaf() {
    if env::var_os(LEAF_ENV).is_none() {
        return;
    }
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

#[test]
fn process_tree_guard_helper() {
    if env::var_os(HELPER_ENV).is_none() {
        return;
    }
    install_process_tree_guard().expect("install process-tree guard");
    install_process_tree_guard().expect("install process-tree guard twice");

    let executable = env::current_exe().expect("resolve test executable");
    let leaf = Command::new(executable)
        .args([
            "--exact",
            "process_tree_guard_leaf",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_remove(HELPER_ENV)
        .env(LEAF_ENV, "1")
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .expect("spawn guarded leaf process");
    let pid_file = env::var_os(PID_FILE_ENV).expect("guard PID file path");
    std::fs::write(pid_file, leaf.id().to_string()).expect("write guarded leaf PID");

    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

#[test]
fn force_killing_owner_reaps_its_descendants() {
    let temporary = tempfile::tempdir().expect("create guard test directory");
    let pid_file = temporary.path().join("leaf.pid");
    let executable = env::current_exe().expect("resolve test executable");
    let mut helper = Command::new(executable)
        .args([
            "--exact",
            "process_tree_guard_helper",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(HELPER_ENV, "1")
        .env(PID_FILE_ENV, &pid_file)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .expect("spawn process-tree guard helper");

    let deadline = Instant::now() + Duration::from_secs(10);
    let leaf_pid = loop {
        if let Ok(value) = std::fs::read_to_string(&pid_file) {
            break value.trim().parse::<u32>().expect("parse guarded leaf PID");
        }
        if let Some(status) = helper.try_wait().expect("poll guard helper") {
            panic!("process-tree guard helper exited before readiness: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "process-tree guard helper did not become ready"
        );
        thread::sleep(Duration::from_millis(25));
    };

    let leaf = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, leaf_pid) };
    assert!(!leaf.is_null(), "open guarded leaf process");

    helper.kill().expect("force-kill process-tree owner");
    let _ = helper.wait();
    let wait_result = unsafe { WaitForSingleObject(leaf, 5_000) };
    if wait_result != WAIT_OBJECT_0 {
        unsafe {
            TerminateProcess(leaf, 1);
            WaitForSingleObject(leaf, 5_000);
        }
    }
    unsafe { CloseHandle(leaf) };

    assert_eq!(
        wait_result, WAIT_OBJECT_0,
        "guarded descendant survived its owner"
    );
}
