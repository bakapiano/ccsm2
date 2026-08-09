use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("resource not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("platform error: {0}")]
    Platform(String),
}

pub type BackendResult<T> = Result<T, BackendError>;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../apps/desktop/src/generated/")]
pub struct ApiErrorDto {
    pub code: String,
    pub message: String,
}

impl From<BackendError> for ApiErrorDto {
    fn from(error: BackendError) -> Self {
        let code = match &error {
            BackendError::NotFound(_) => "not_found",
            BackendError::Conflict(_) => "conflict",
            BackendError::Invalid(_) => "invalid_request",
            BackendError::Storage(_) => "storage_error",
            BackendError::Platform(_) => "platform_error",
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
        }
    }
}
