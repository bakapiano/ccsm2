mod board;
mod board_mcp;
mod containment;
mod filesystem;
mod git;
mod hook;
mod pty;
mod shim;
mod store;
mod watch;

pub use board::LocalBoardStore;
pub use board_mcp::run_board_mcp_server;
pub use containment::{install_process_tree_guard, run_process_watchdog};
pub use filesystem::{
    HostDirectoryEntry, HostDirectoryListing, HostDirectoryStart, LocalFileSystemBackend,
};
pub use git::CommandGitBackend;
pub use hook::{
    BoardChangeReportSink, HookReportSink, LocalHookEndpoint, resolve_hook_display_title,
    run_hook_reporter,
};
pub use pty::{PortablePtyBackend, cleanup_stale_runtime_shim_roots};
pub use shim::{provider_from_environment, provider_from_executable, run_cli_shim};
pub use store::SqliteStateStore;
pub use watch::NotifyFileWatchBackend;
