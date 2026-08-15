use std::path::Path;

use ccsm_platform::{HostDirectoryEntry, HostDirectoryListing, HostDirectoryStart};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct BrowseHostDirectoryRequest {
    pub path: Option<String>,
    pub workspace_root: Option<String>,
    pub operation_id: String,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct CreateHostDirectoryRequest {
    pub parent_path: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct HostDirectoryEntryDto {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct HostDirectoryStartDto {
    pub label: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/")]
pub struct HostDirectoryListingDto {
    pub path: String,
    pub parent: Option<String>,
    pub exists: bool,
    pub entries: Vec<HostDirectoryEntryDto>,
    pub next_offset: Option<u32>,
    pub starts: Vec<HostDirectoryStartDto>,
}

impl From<HostDirectoryEntry> for HostDirectoryEntryDto {
    fn from(value: HostDirectoryEntry) -> Self {
        Self {
            name: value.name,
            path: value.path,
        }
    }
}

impl From<HostDirectoryStart> for HostDirectoryStartDto {
    fn from(value: HostDirectoryStart) -> Self {
        Self {
            label: value.label,
            path: value.path,
        }
    }
}

impl From<HostDirectoryListing> for HostDirectoryListingDto {
    fn from(value: HostDirectoryListing) -> Self {
        Self {
            path: value.path,
            parent: value.parent,
            exists: value.exists,
            entries: value.entries.into_iter().map(Into::into).collect(),
            next_offset: value.next_offset,
            starts: value.starts.into_iter().map(Into::into).collect(),
        }
    }
}

pub fn workspace_root(request: &BrowseHostDirectoryRequest) -> Option<&Path> {
    request.workspace_root.as_deref().map(Path::new)
}
