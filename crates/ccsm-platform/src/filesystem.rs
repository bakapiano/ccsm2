use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::UNIX_EPOCH,
};

use ccsm_core::{
    dto::{
        FileDocumentDto, FileEntryDto, FileEntryKind, FileLineEnding, FileOpenStatus,
        ResolvedFileReferenceDto, WriteFileRequest, WriteFileResultDto,
    },
    error::{BackendError, BackendResult},
    ports::{DirectoryPage, FileSystemBackend, RootDescriptor},
};

const MAX_DIRECTORY_PAGE_SIZE: u32 = 500;

#[derive(Default)]
pub struct LocalFileSystemBackend {
    directory_operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

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
    pub next_offset: Option<u32>,
    pub starts: Vec<HostDirectoryStart>,
}

impl LocalFileSystemBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn browse_host_directory(
        &self,
        requested_path: Option<&str>,
        home: &Path,
        workspace_root: Option<&Path>,
        operation_id: &str,
        offset: u32,
        limit: u32,
    ) -> BackendResult<HostDirectoryListing> {
        let operation = self.begin_directory_operation(operation_id)?;
        let limit = validated_directory_page_limit(limit)?;
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
        let mut entries = Vec::new();
        if exists && let Ok(children) = std::fs::read_dir(&path) {
            let mut visible_index = 0_u32;
            for child in children {
                operation.check()?;
                let Ok(entry) = child else { continue };
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    continue;
                }
                if visible_index < offset {
                    visible_index = visible_index.saturating_add(1);
                    continue;
                }
                entries.push(HostDirectoryEntry {
                    name,
                    path: persisted_path(&entry.path()),
                });
                visible_index = visible_index.saturating_add(1);
                if entries.len() > limit as usize {
                    break;
                }
            }
        }
        let next_offset = (entries.len() > limit as usize).then_some(offset.saturating_add(limit));
        entries.truncate(limit as usize);
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
            next_offset,
            starts,
        })
    }

    pub fn cancel_directory_operation(&self, operation_id: &str) {
        if let Ok(operations) = self.directory_operations.lock()
            && let Some(operation) = operations.get(operation_id)
        {
            operation.store(true, Ordering::Release);
        }
    }

    pub fn prepare_directory_operation(&self, operation_id: &str) -> BackendResult<()> {
        validate_directory_operation_id(operation_id)?;
        let mut operations = self.directory_operations.lock().map_err(|_| {
            BackendError::Platform("directory operation registry lock poisoned".into())
        })?;
        if operations.contains_key(operation_id) {
            return Err(BackendError::Invalid(
                "directory operation identifier is already active".into(),
            ));
        }
        operations.insert(operation_id.to_string(), Arc::new(AtomicBool::new(false)));
        Ok(())
    }

    pub fn finish_directory_operation(&self, operation_id: &str) {
        if let Ok(mut operations) = self.directory_operations.lock() {
            operations.remove(operation_id);
        }
    }

    fn begin_directory_operation(
        &self,
        operation_id: &str,
    ) -> BackendResult<DirectoryOperationGuard<'_>> {
        validate_directory_operation_id(operation_id)?;
        let mut operations = self.directory_operations.lock().map_err(|_| {
            BackendError::Platform("directory operation registry lock poisoned".into())
        })?;
        let cancellation = operations
            .entry(operation_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone();
        drop(operations);
        let guard = DirectoryOperationGuard {
            backend: self,
            operation_id: operation_id.to_string(),
            cancellation,
        };
        guard.check()?;
        Ok(guard)
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

impl FileSystemBackend for LocalFileSystemBackend {
    fn resolve_file_reference(
        &self,
        root: &RootDescriptor,
        path: &str,
    ) -> BackendResult<ResolvedFileReferenceDto> {
        let path = path.trim();
        if path.is_empty() || path.len() > 4096 {
            return Err(BackendError::Invalid("invalid file reference".into()));
        }
        let root_path = canonical_root(root)?;
        let requested = PathBuf::from(path);
        let unresolved = if requested.is_absolute() {
            requested
        } else {
            root_path.join(requested)
        };
        let resolved = unresolved.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                BackendError::NotFound(format!("file reference {path}"))
            } else {
                BackendError::Platform(format!("canonicalize file reference: {error}"))
            }
        })?;
        if !resolved.starts_with(&root_path) {
            return Err(BackendError::Invalid(
                "file reference escapes the canonical Space root".into(),
            ));
        }
        if !resolved.is_file() {
            return Err(BackendError::Invalid("file reference is not a file".into()));
        }
        let relative = resolved.strip_prefix(&root_path).map_err(|_| {
            BackendError::Invalid("file reference is outside the Space root".into())
        })?;
        Ok(ResolvedFileReferenceDto {
            space_id: root.space_id.clone(),
            relative_path: path_to_slashes(relative),
        })
    }

    fn list_directory(
        &self,
        root: &RootDescriptor,
        relative_path: &str,
        operation_id: &str,
        offset: u32,
        limit: u32,
    ) -> BackendResult<DirectoryPage> {
        let operation = self.begin_directory_operation(operation_id)?;
        let limit = validated_directory_page_limit(limit)?;
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

        let children = std::fs::read_dir(&directory)
            .map_err(|error| BackendError::Platform(format!("read directory: {error}")))?;
        let mut entries = Vec::new();
        for (index, entry) in children.enumerate() {
            operation.check()?;
            if index < offset as usize {
                continue;
            }
            let entry = entry.map_err(|error| {
                BackendError::Platform(format!("read directory entry: {error}"))
            })?;
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|error| BackendError::Platform(format!("read file metadata: {error}")))?;
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
            entries.push(FileEntryDto {
                name: entry.file_name().to_string_lossy().into_owned(),
                relative_path: path_to_slashes(&child_relative),
                kind,
                size: metadata.is_file().then_some(metadata.len() as f64),
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs_f64()),
            });
            if entries.len() > limit as usize {
                break;
            }
        }
        let next_offset = (entries.len() > limit as usize).then_some(offset.saturating_add(limit));
        entries.truncate(limit as usize);
        entries.sort_by(|left, right| {
            entry_rank(left.kind)
                .cmp(&entry_rank(right.kind))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(DirectoryPage {
            entries,
            next_offset,
        })
    }

    fn cancel_directory_operation(&self, operation_id: &str) {
        self.cancel_directory_operation(operation_id);
    }

    fn read_file(
        &self,
        root: &RootDescriptor,
        relative_path: &str,
    ) -> BackendResult<FileDocumentDto> {
        let path = existing_file_path(root, relative_path)?;
        let metadata = std::fs::metadata(&path)
            .map_err(|error| BackendError::Platform(format!("read file metadata: {error}")))?;
        let size = metadata.len();
        if size > MAX_EDITABLE_FILE_SIZE {
            return Ok(file_document_without_content(
                root,
                relative_path,
                size,
                FileOpenStatus::TooLarge,
                "File is larger than 5 MiB.",
            ));
        }

        let bytes = std::fs::read(&path)
            .map_err(|error| BackendError::Platform(format!("read file: {error}")))?;
        let utf8_bom = bytes.starts_with(UTF8_BOM);
        let body = if utf8_bom {
            &bytes[UTF8_BOM.len()..]
        } else {
            &bytes
        };
        let line_ending = if body.windows(2).any(|pair| pair == b"\r\n") {
            FileLineEnding::CrLf
        } else {
            FileLineEnding::Lf
        };
        if body.contains(&0) {
            return Ok(FileDocumentDto {
                space_id: root.space_id.clone(),
                relative_path: relative_path.to_string(),
                content: None,
                status: FileOpenStatus::Binary,
                reason: Some("Binary files are not supported.".into()),
                size: size as f64,
                revision: Some(file_revision(&bytes, &metadata)),
                utf8_bom,
                line_ending,
                syntax_highlighting: false,
            });
        }
        let decoded = match std::str::from_utf8(body) {
            Ok(value) => value,
            Err(_) => {
                return Ok(FileDocumentDto {
                    space_id: root.space_id.clone(),
                    relative_path: relative_path.to_string(),
                    content: None,
                    status: FileOpenStatus::UnsupportedEncoding,
                    reason: Some("Only UTF-8 encoded text files are supported.".into()),
                    size: size as f64,
                    revision: Some(file_revision(&bytes, &metadata)),
                    utf8_bom,
                    line_ending,
                    syntax_highlighting: false,
                });
            }
        };
        let read_only = metadata.permissions().readonly();
        let large = size > SYNTAX_HIGHLIGHT_FILE_SIZE;
        Ok(FileDocumentDto {
            space_id: root.space_id.clone(),
            relative_path: relative_path.to_string(),
            content: Some(normalize_line_endings(decoded)),
            status: if read_only {
                FileOpenStatus::ReadOnly
            } else {
                FileOpenStatus::Editable
            },
            reason: if read_only {
                Some("File is read-only.".into())
            } else if large {
                Some("Large file: syntax highlighting is disabled.".into())
            } else {
                None
            },
            size: size as f64,
            revision: Some(file_revision(&bytes, &metadata)),
            utf8_bom,
            line_ending,
            syntax_highlighting: !large,
        })
    }

    fn write_file(
        &self,
        root: &RootDescriptor,
        request: &WriteFileRequest,
    ) -> BackendResult<WriteFileResultDto> {
        if request.space_id != root.space_id {
            return Err(BackendError::Conflict(
                "file write Space does not match the active root".into(),
            ));
        }
        let relative = validated_file_relative_path(&request.relative_path)?;
        let root_path = canonical_root(root)?;
        let unresolved = root_path.join(&relative);
        let (path, exists) = match unresolved.canonicalize() {
            Ok(path) => {
                if !path.starts_with(&root_path) {
                    return Err(BackendError::Invalid(
                        "file escapes the canonical Space root".into(),
                    ));
                }
                (path, true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !request.recreate {
                    return Err(BackendError::Conflict(
                        "File no longer exists on disk.".into(),
                    ));
                }
                let parent = unresolved.parent().ok_or_else(|| {
                    BackendError::Invalid("file path has no parent directory".into())
                })?;
                let parent = parent.canonicalize().map_err(|error| {
                    BackendError::NotFound(format!("file parent directory: {error}"))
                })?;
                if !parent.starts_with(&root_path) {
                    return Err(BackendError::Invalid(
                        "file parent escapes the canonical Space root".into(),
                    ));
                }
                let name = relative
                    .file_name()
                    .ok_or_else(|| BackendError::Invalid("file path must name a file".into()))?;
                (parent.join(name), false)
            }
            Err(error) => {
                return Err(BackendError::Platform(format!(
                    "canonicalize file: {error}"
                )));
            }
        };

        if exists {
            if !path.is_file() {
                return Err(BackendError::Invalid("path is not a file".into()));
            }
            let metadata = std::fs::metadata(&path)
                .map_err(|error| BackendError::Platform(format!("read file metadata: {error}")))?;
            if metadata.permissions().readonly() {
                return Err(BackendError::Platform("file is read-only".into()));
            }
            let current = std::fs::read(&path)
                .map_err(|error| BackendError::Platform(format!("read file: {error}")))?;
            let revision = file_revision(&current, &metadata);
            if !request.overwrite && request.expected_revision.as_deref() != Some(revision.as_str())
            {
                return Err(BackendError::Conflict(
                    "File changed on disk since it was loaded.".into(),
                ));
            }
        }

        let normalized = normalize_line_endings(&request.content);
        let encoded = match request.line_ending {
            FileLineEnding::Lf => normalized,
            FileLineEnding::CrLf => normalized.replace('\n', "\r\n"),
        };
        let mut bytes = Vec::with_capacity(encoded.len() + UTF8_BOM.len());
        if request.utf8_bom {
            bytes.extend_from_slice(UTF8_BOM);
        }
        bytes.extend_from_slice(encoded.as_bytes());
        if bytes.len() as u64 > MAX_EDITABLE_FILE_SIZE {
            return Err(BackendError::Invalid(
                "edited file would exceed the 5 MiB limit".into(),
            ));
        }
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .create(request.recreate)
            .open(&path)
            .map_err(|error| BackendError::Platform(format!("open file for writing: {error}")))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| BackendError::Platform(format!("write file: {error}")))?;
        let metadata = file.metadata().map_err(|error| {
            BackendError::Platform(format!("read saved file metadata: {error}"))
        })?;
        Ok(WriteFileResultDto {
            space_id: root.space_id.clone(),
            relative_path: request.relative_path.clone(),
            revision: file_revision(&bytes, &metadata),
            size: bytes.len() as f64,
        })
    }
}

const UTF8_BOM: &[u8; 3] = b"\xEF\xBB\xBF";
const SYNTAX_HIGHLIGHT_FILE_SIZE: u64 = 1024 * 1024;
const MAX_EDITABLE_FILE_SIZE: u64 = 5 * 1024 * 1024;

fn canonical_root(root: &RootDescriptor) -> BackendResult<PathBuf> {
    PathBuf::from(&root.root_path)
        .canonicalize()
        .map_err(|error| BackendError::Platform(format!("canonicalize Space root: {error}")))
}

fn existing_file_path(root: &RootDescriptor, relative_path: &str) -> BackendResult<PathBuf> {
    let root_path = canonical_root(root)?;
    let relative = validated_file_relative_path(relative_path)?;
    let path = root_path.join(&relative).canonicalize().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            BackendError::NotFound(format!("file {relative_path}"))
        } else {
            BackendError::Platform(format!("canonicalize file: {error}"))
        }
    })?;
    if !path.starts_with(&root_path) {
        return Err(BackendError::Invalid(
            "file escapes the canonical Space root".into(),
        ));
    }
    if !path.is_file() {
        return Err(BackendError::Invalid(format!(
            "path is not a file: {}",
            path.display()
        )));
    }
    Ok(path)
}

fn validated_file_relative_path(value: &str) -> BackendResult<PathBuf> {
    let path = validated_relative_path(value)?;
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(BackendError::Invalid("file path must name a file".into()));
    }
    Ok(path)
}

fn normalize_line_endings(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn file_revision(bytes: &[u8], metadata: &std::fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    format!("{modified:x}-{:x}-{hash:x}", bytes.len())
}

fn file_document_without_content(
    root: &RootDescriptor,
    relative_path: &str,
    size: u64,
    status: FileOpenStatus,
    reason: &str,
) -> FileDocumentDto {
    FileDocumentDto {
        space_id: root.space_id.clone(),
        relative_path: relative_path.to_string(),
        content: None,
        status,
        reason: Some(reason.into()),
        size: size as f64,
        revision: None,
        utf8_bom: false,
        line_ending: FileLineEnding::Lf,
        syntax_highlighting: false,
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

struct DirectoryOperationGuard<'a> {
    backend: &'a LocalFileSystemBackend,
    operation_id: String,
    cancellation: Arc<AtomicBool>,
}

impl DirectoryOperationGuard<'_> {
    fn check(&self) -> BackendResult<()> {
        if self.cancellation.load(Ordering::Acquire) {
            Err(BackendError::Platform(
                "directory operation cancelled".into(),
            ))
        } else {
            Ok(())
        }
    }
}

impl Drop for DirectoryOperationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.backend.directory_operations.lock()
            && operations
                .get(&self.operation_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.cancellation))
        {
            operations.remove(&self.operation_id);
        }
    }
}

fn validated_directory_page_limit(limit: u32) -> BackendResult<u32> {
    if limit == 0 || limit > MAX_DIRECTORY_PAGE_SIZE {
        return Err(BackendError::Invalid(format!(
            "directory page size must be between 1 and {MAX_DIRECTORY_PAGE_SIZE}"
        )));
    }
    Ok(limit)
}

fn validate_directory_operation_id(operation_id: &str) -> BackendResult<()> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err(BackendError::Invalid(
            "invalid directory operation identifier".into(),
        ));
    }
    Ok(())
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

    fn root_descriptor(path: &Path) -> RootDescriptor {
        RootDescriptor {
            space_id: "space-1".into(),
            root_id: "root-1".into(),
            root_path: path.to_string_lossy().into_owned(),
        }
    }

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
                "browse-test",
                0,
                200,
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

    #[test]
    fn directory_pages_bound_results_and_honor_cancellation() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..501 {
            std::fs::write(root.path().join(format!("file-{index:04}.txt")), b"x").unwrap();
        }
        let filesystem = LocalFileSystemBackend::new();
        let descriptor = root_descriptor(root.path());

        let first = filesystem
            .list_directory(&descriptor, "", "page-one", 0, 200)
            .unwrap();
        let second = filesystem
            .list_directory(&descriptor, "", "page-two", 200, 200)
            .unwrap();
        assert_eq!(first.entries.len(), 200);
        assert_eq!(first.next_offset, Some(200));
        assert_eq!(second.entries.len(), 200);
        assert_eq!(second.next_offset, Some(400));

        filesystem
            .prepare_directory_operation("cancelled-page")
            .unwrap();
        filesystem.cancel_directory_operation("cancelled-page");
        let error = filesystem
            .list_directory(&descriptor, "", "cancelled-page", 0, 200)
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));

        filesystem.cancel_directory_operation("completed-page");
        filesystem
            .prepare_directory_operation("completed-page")
            .unwrap();
        filesystem.finish_directory_operation("completed-page");
    }

    #[test]
    fn reads_and_saves_utf8_bom_crlf_without_changing_format() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        std::fs::write(&path, b"\xEF\xBB\xBFfirst\r\nsecond").unwrap();
        let filesystem = LocalFileSystemBackend::new();
        let descriptor = root_descriptor(root.path());

        let loaded = filesystem.read_file(&descriptor, "notes.txt").unwrap();
        assert_eq!(loaded.content.as_deref(), Some("first\nsecond"));
        assert!(loaded.utf8_bom);
        assert_eq!(loaded.line_ending, FileLineEnding::CrLf);

        let saved = filesystem
            .write_file(
                &descriptor,
                &WriteFileRequest {
                    space_id: descriptor.space_id.clone(),
                    relative_path: "notes.txt".into(),
                    content: "first\n中文".into(),
                    expected_revision: loaded.revision,
                    utf8_bom: true,
                    line_ending: FileLineEnding::CrLf,
                    overwrite: false,
                    recreate: false,
                },
            )
            .unwrap();

        assert!(!saved.revision.is_empty());
        assert_eq!(
            std::fs::read(path).unwrap(),
            b"\xEF\xBB\xBFfirst\r\n\xE4\xB8\xAD\xE6\x96\x87"
        );
    }

    #[test]
    fn resolves_relative_and_absolute_file_references_inside_the_space() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("src");
        std::fs::create_dir(&nested).unwrap();
        let file = nested.join("main.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();
        let filesystem = LocalFileSystemBackend::new();
        let descriptor = root_descriptor(root.path());

        let relative = filesystem
            .resolve_file_reference(&descriptor, "src/main.rs")
            .unwrap();
        let absolute = filesystem
            .resolve_file_reference(&descriptor, file.to_string_lossy().as_ref())
            .unwrap();

        assert_eq!(relative.relative_path, "src/main.rs");
        assert_eq!(absolute.relative_path, "src/main.rs");
    }

    #[test]
    fn rejects_file_references_outside_the_space_and_directories() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        let filesystem = LocalFileSystemBackend::new();
        let descriptor = root_descriptor(root.path());

        assert!(matches!(
            filesystem
                .resolve_file_reference(&descriptor, outside.path().to_string_lossy().as_ref()),
            Err(BackendError::Invalid(_))
        ));
        assert!(matches!(
            filesystem.resolve_file_reference(&descriptor, "src"),
            Err(BackendError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_stale_writes_until_overwrite_is_explicit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("conflict.txt");
        std::fs::write(&path, "original").unwrap();
        let filesystem = LocalFileSystemBackend::new();
        let descriptor = root_descriptor(root.path());
        let loaded = filesystem.read_file(&descriptor, "conflict.txt").unwrap();
        std::fs::write(&path, "external").unwrap();
        let mut request = WriteFileRequest {
            space_id: descriptor.space_id.clone(),
            relative_path: "conflict.txt".into(),
            content: "local".into(),
            expected_revision: loaded.revision,
            utf8_bom: false,
            line_ending: FileLineEnding::Lf,
            overwrite: false,
            recreate: false,
        };

        assert!(matches!(
            filesystem.write_file(&descriptor, &request),
            Err(BackendError::Conflict(_))
        ));
        request.overwrite = true;
        filesystem.write_file(&descriptor, &request).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "local");
    }

    #[test]
    fn classifies_binary_and_non_utf8_files_as_not_editable() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("binary.bin"), [1, 0, 2]).unwrap();
        std::fs::write(root.path().join("legacy.txt"), [0xff, 0xfe]).unwrap();
        let filesystem = LocalFileSystemBackend::new();
        let descriptor = root_descriptor(root.path());

        assert_eq!(
            filesystem
                .read_file(&descriptor, "binary.bin")
                .unwrap()
                .status,
            FileOpenStatus::Binary
        );
        assert_eq!(
            filesystem
                .read_file(&descriptor, "legacy.txt")
                .unwrap()
                .status,
            FileOpenStatus::UnsupportedEncoding
        );
    }
}
