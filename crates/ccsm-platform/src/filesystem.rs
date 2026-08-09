use std::{
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use ccsm_core::{
    dto::{FileEntryDto, FileEntryKind},
    error::{BackendError, BackendResult},
    ports::{FileSystemBackend, RootDescriptor},
};

pub struct LocalFileSystemBackend;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostDirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostDirectoryStart {
    pub label: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostDirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub exists: bool,
    pub entries: Vec<HostDirectoryEntry>,
    pub starts: Vec<HostDirectoryStart>,
}

impl LocalFileSystemBackend {
    pub fn new() -> Self {
        Self
    }

    pub fn browse_host_directory(
        &self,
        requested_path: Option<&str>,
        home: &Path,
        workspace_root: Option<&Path>,
    ) -> BackendResult<HostDirectoryListing> {
        let requested = requested_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.to_path_buf());
        let absolute = if requested.is_absolute() {
            requested
        } else {
            home.join(requested)
        };
        let path = std::fs::canonicalize(&absolute).unwrap_or(absolute);
        let exists = path.is_dir();
        let mut entries = if exists {
            match std::fs::read_dir(&path) {
                Ok(entries) => entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        if name.starts_with('.') {
                            return None;
                        }
                        entry
                            .file_type()
                            .ok()
                            .filter(|kind| kind.is_dir())
                            .map(|_| HostDirectoryEntry {
                                name,
                                path: persisted_path(&entry.path()),
                            })
                    })
                    .collect(),
                Err(_) => Vec::new(),
            }
        } else {
            Vec::new()
        };
        entries.sort_by(|left: &HostDirectoryEntry, right: &HostDirectoryEntry| {
            left.name.to_lowercase().cmp(&right.name.to_lowercase())
        });

        let parent = path
            .parent()
            .filter(|parent| *parent != path)
            .map(persisted_path);
        let mut starts = Vec::new();
        push_host_start(&mut starts, "Home", home);
        if let Some(workspace_root) = workspace_root {
            push_host_start(&mut starts, "Current Space", workspace_root);
        }
        push_platform_roots(&mut starts);

        Ok(HostDirectoryListing {
            path: persisted_path(&path),
            parent,
            exists,
            entries,
            starts,
        })
    }

    pub fn create_host_directory(
        &self,
        parent_path: &str,
        name: &str,
    ) -> BackendResult<HostDirectoryEntry> {
        let name = validated_directory_name(name)?;
        let parent = PathBuf::from(parent_path)
            .canonicalize()
            .map_err(|error| BackendError::NotFound(format!("parent directory: {error}")))?;
        if !parent.is_dir() {
            return Err(BackendError::Invalid(
                "parent path is not a directory".into(),
            ));
        }
        let child = parent.join(name);
        std::fs::create_dir(&child).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                BackendError::Conflict("folder already exists".into())
            } else {
                BackendError::Platform(format!("create folder: {error}"))
            }
        })?;
        Ok(HostDirectoryEntry {
            name: name.to_string(),
            path: persisted_path(&child),
        })
    }
}

impl Default for LocalFileSystemBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl FileSystemBackend for LocalFileSystemBackend {
    fn list_directory(
        &self,
        root: &RootDescriptor,
        relative_path: &str,
    ) -> BackendResult<Vec<FileEntryDto>> {
        let root_path = PathBuf::from(&root.root_path)
            .canonicalize()
            .map_err(|error| BackendError::Platform(format!("canonicalize Space root: {error}")))?;
        let relative = validated_relative_path(relative_path)?;
        let directory = root_path.join(&relative).canonicalize().map_err(|error| {
            BackendError::NotFound(format!("directory {}: {error}", relative.display()))
        })?;
        if !directory.starts_with(&root_path) {
            return Err(BackendError::Invalid(
                "directory escapes the canonical Space root".into(),
            ));
        }
        if !directory.is_dir() {
            return Err(BackendError::Invalid(format!(
                "path is not a directory: {}",
                directory.display()
            )));
        }

        let mut entries = std::fs::read_dir(&directory)
            .map_err(|error| BackendError::Platform(format!("read directory: {error}")))?
            .map(|entry| {
                let entry = entry.map_err(|error| {
                    BackendError::Platform(format!("read directory entry: {error}"))
                })?;
                let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
                    BackendError::Platform(format!("read file metadata: {error}"))
                })?;
                let kind = if metadata.file_type().is_symlink() {
                    FileEntryKind::Symlink
                } else if metadata.is_dir() {
                    FileEntryKind::Directory
                } else if metadata.is_file() {
                    FileEntryKind::File
                } else {
                    FileEntryKind::Other
                };
                let child_relative = relative.join(entry.file_name());
                Ok(FileEntryDto {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    relative_path: path_to_slashes(&child_relative),
                    kind,
                    size: metadata.is_file().then_some(metadata.len() as f64),
                    modified_at: metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|duration| duration.as_secs_f64()),
                })
            })
            .collect::<BackendResult<Vec<_>>>()?;
        entries.sort_by(|left, right| {
            entry_rank(left.kind)
                .cmp(&entry_rank(right.kind))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }
}

fn validated_relative_path(value: &str) -> BackendResult<PathBuf> {
    let mut result = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            Component::Normal(value) => result.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(BackendError::Invalid(
                    "filesystem paths must be Space-relative".into(),
                ));
            }
        }
    }
    Ok(result)
}

fn path_to_slashes(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn entry_rank(kind: FileEntryKind) -> u8 {
    match kind {
        FileEntryKind::Directory => 0,
        FileEntryKind::Symlink => 1,
        FileEntryKind::File => 2,
        FileEntryKind::Other => 3,
    }
}

fn validated_directory_name(value: &str) -> BackendResult<&str> {
    let value = value.trim();
    let invalid_character = value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    });
    let windows_reserved = value.split('.').next().is_some_and(|stem| {
        matches!(
            stem.to_ascii_lowercase().as_str(),
            "con"
                | "prn"
                | "aux"
                | "nul"
                | "com1"
                | "com2"
                | "com3"
                | "com4"
                | "com5"
                | "com6"
                | "com7"
                | "com8"
                | "com9"
                | "lpt1"
                | "lpt2"
                | "lpt3"
                | "lpt4"
                | "lpt5"
                | "lpt6"
                | "lpt7"
                | "lpt8"
                | "lpt9"
        )
    });
    if value.is_empty()
        || matches!(value, "." | "..")
        || invalid_character
        || windows_reserved
        || value.starts_with(['.', ' '])
        || value.ends_with(['.', ' '])
    {
        return Err(BackendError::Invalid("invalid folder name".into()));
    }
    Ok(value)
}

fn push_host_start(starts: &mut Vec<HostDirectoryStart>, label: &str, path: &Path) {
    if !path.is_dir() {
        return;
    }
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let persisted = persisted_path(&path);
    if starts
        .iter()
        .any(|start| paths_equal(&start.path, &persisted))
    {
        return;
    }
    starts.push(HostDirectoryStart {
        label: label.to_string(),
        path: persisted,
    });
}

#[cfg(windows)]
fn push_platform_roots(starts: &mut Vec<HostDirectoryStart>) {
    for letter in b'C'..=b'H' {
        let label = format!("{}:\\", char::from(letter));
        push_host_start(starts, &label, Path::new(&label));
    }
}

#[cfg(not(windows))]
fn push_platform_roots(starts: &mut Vec<HostDirectoryStart>) {
    push_host_start(starts, "/", Path::new("/"));
}

fn paths_equal(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

#[cfg(windows)]
fn persisted_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{path}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

#[cfg(not(windows))]
fn persisted_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod host_directory_tests {
    use super::*;

    #[test]
    fn browses_only_visible_child_directories() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("Beta")).unwrap();
        std::fs::create_dir(root.path().join("alpha")).unwrap();
        std::fs::create_dir(root.path().join(".hidden")).unwrap();
        std::fs::write(root.path().join("file.txt"), "content").unwrap();

        let listing = LocalFileSystemBackend::new()
            .browse_host_directory(
                Some(root.path().to_string_lossy().as_ref()),
                root.path(),
                None,
            )
            .unwrap();

        assert!(listing.exists);
        assert!(!listing.path.starts_with(r"\\?\"));
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "Beta"]
        );
    }

    #[test]
    fn creates_a_child_directory_and_rejects_traversal_names() {
        let root = tempfile::tempdir().unwrap();
        let filesystem = LocalFileSystemBackend::new();
        let created = filesystem
            .create_host_directory(root.path().to_string_lossy().as_ref(), "project")
            .unwrap();
        assert!(Path::new(&created.path).is_dir());
        assert!(
            filesystem
                .create_host_directory(root.path().to_string_lossy().as_ref(), "../escape")
                .is_err()
        );
    }
}
