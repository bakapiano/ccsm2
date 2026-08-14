use ccsm_core::error::{BackendError, BackendResult};

#[cfg(windows)]
mod windows {
    use std::{mem::size_of, sync::OnceLock};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject,
            },
            Threading::{
                GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SET_QUOTA, PROCESS_TERMINATE,
            },
        },
    };

    use super::{BackendError, BackendResult};

    pub struct ProcessContainment {
        job: HANDLE,
    }

    unsafe impl Send for ProcessContainment {}
    unsafe impl Sync for ProcessContainment {}

    struct ProcessTreeJob {
        _job: HANDLE,
    }

    unsafe impl Send for ProcessTreeJob {}
    unsafe impl Sync for ProcessTreeJob {}

    // This handle intentionally lives until Windows tears the process down. It must not be
    // closed while the desktop process is still alive because kill-on-close also applies to
    // the desktop process itself.
    static PROCESS_TREE_JOB: OnceLock<Result<ProcessTreeJob, String>> = OnceLock::new();

    pub fn install_process_tree_guard() -> BackendResult<()> {
        match PROCESS_TREE_JOB.get_or_init(create_process_tree_job) {
            Ok(_) => Ok(()),
            Err(error) => Err(BackendError::Platform(error.clone())),
        }
    }

    fn create_process_tree_job() -> Result<ProcessTreeJob, String> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(last_error_message("Create desktop Job Object"));
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = last_error_message("Configure desktop Job Object");
                CloseHandle(job);
                return Err(error);
            }

            if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                let error = last_error_message("Assign desktop process to Job Object");
                CloseHandle(job);
                return Err(error);
            }

            Ok(ProcessTreeJob { _job: job })
        }
    }

    impl ProcessContainment {
        pub fn attach(pid: Option<u32>) -> BackendResult<Self> {
            let pid =
                pid.ok_or_else(|| BackendError::Platform("spawned process has no PID".into()))?;
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(last_error("CreateJobObjectW"));
                }

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    CloseHandle(job);
                    return Err(last_error("SetInformationJobObject"));
                }

                let process = OpenProcess(
                    PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid,
                );
                if process.is_null() {
                    CloseHandle(job);
                    return Err(last_error("OpenProcess"));
                }
                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    CloseHandle(job);
                    return Err(last_error("AssignProcessToJobObject"));
                }
                Ok(Self { job })
            }
        }

        pub fn terminate(&self) -> BackendResult<()> {
            if unsafe { TerminateJobObject(self.job, 1) } == 0 {
                Err(last_error("TerminateJobObject"))
            } else {
                Ok(())
            }
        }
    }

    impl Drop for ProcessContainment {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.job);
            }
        }
    }

    fn last_error(operation: &str) -> BackendError {
        BackendError::Platform(last_error_message(operation))
    }

    fn last_error_message(operation: &str) -> String {
        format!("{operation} failed: {}", std::io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
mod unix {
    use std::{io::Read, thread, time::Duration};

    use super::{BackendError, BackendResult};

    pub struct ProcessContainment {
        pgid: i32,
    }

    impl ProcessContainment {
        pub fn attach(pid: Option<u32>) -> BackendResult<Self> {
            let pid =
                pid.ok_or_else(|| BackendError::Platform("spawned process has no PID".into()))?;
            let pgid = i32::try_from(pid)
                .map_err(|_| BackendError::Platform(format!("process PID {pid} exceeds i32")))?;
            Ok(Self { pgid })
        }

        pub fn terminate(&self) -> BackendResult<()> {
            signal_group(self.pgid, libc::SIGTERM)?;
            for _ in 0..25 {
                if !process_group_exists(self.pgid) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(20));
            }
            signal_group(self.pgid, libc::SIGKILL)
        }
    }

    pub fn install_process_tree_guard() -> BackendResult<()> {
        Ok(())
    }

    pub fn run_process_watchdog(pgid: i32) -> i32 {
        if pgid <= 0 {
            eprintln!("ccsm process watchdog requires a positive process group ID");
            return 2;
        }
        let mut input = std::io::stdin().lock();
        let mut buffer = [0_u8; 64];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = signal_group(pgid, libc::SIGKILL);
        0
    }

    fn process_group_exists(pgid: i32) -> bool {
        let result = unsafe { libc::kill(-pgid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn signal_group(pgid: i32, signal: i32) -> BackendResult<()> {
        let result = unsafe { libc::kill(-pgid, signal) };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(BackendError::Platform(format!(
                "signal process group {pgid} with {signal}: {}",
                std::io::Error::last_os_error()
            )))
        }
    }

    #[cfg(test)]
    mod tests {
        use std::{os::unix::process::CommandExt, process::Command, time::Instant};

        use super::*;

        #[test]
        fn containment_terminates_the_unix_process_group() {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "sleep 60 & wait"]);
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = command.spawn().expect("spawn process group fixture");
            let pgid = child.id() as i32;
            let containment = ProcessContainment::attach(Some(child.id())).unwrap();
            containment.terminate().unwrap();

            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if child.try_wait().unwrap().is_some() {
                    assert!(!process_group_exists(pgid));
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            let _ = child.kill();
            panic!("contained Unix process group did not exit");
        }
    }
}

#[cfg(not(windows))]
pub use unix::{ProcessContainment, install_process_tree_guard, run_process_watchdog};
#[cfg(windows)]
pub use windows::{ProcessContainment, install_process_tree_guard};

#[cfg(windows)]
pub fn run_process_watchdog(_pgid: i32) -> i32 {
    eprintln!("ccsm process watchdog mode is only available on Unix");
    2
}
