mod backend;
pub mod dto;
pub mod error;
pub mod ports;
mod root;
mod runtime;

pub use backend::AppBackend;
pub use root::AppEventSink;
pub use runtime::{HookTransportDescriptor, RuntimeEventSink};
