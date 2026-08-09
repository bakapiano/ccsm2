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
    use super::BackendResult;

    pub struct ProcessContainment;

    impl ProcessContainment {
        pub fn attach(_pid: Option<u32>) -> BackendResult<Self> {
            Ok(Self)
        }

        pub fn terminate(&self) -> BackendResult<()> {
            Ok(())
        }
    }

    pub fn install_process_tree_guard() -> BackendResult<()> {
        Ok(())
    }
}

#[cfg(not(windows))]
pub use unix::{ProcessContainment, install_process_tree_guard};
#[cfg(windows)]
pub use windows::{ProcessContainment, install_process_tree_guard};
