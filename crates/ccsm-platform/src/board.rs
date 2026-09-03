use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use ccsm_core::{
    dto::{BoardDocumentDto, BoardSummaryDto},
    error::{BackendError, BackendResult},
    ports::BoardStore,
};
use uuid::Uuid;

const MAX_BOARD_BYTES: usize = 2 * 1024 * 1024;
const MAX_BOARD_ID_BYTES: usize = 96;
const MAX_BOARD_TITLE_CHARACTERS: usize = 160;

#[derive(Debug)]
pub struct LocalBoardStore {
    root: PathBuf,
}

impl LocalBoardStore {
    pub fn open(root: PathBuf) -> BackendResult<Self> {
        fs::create_dir_all(&root).map_err(|error| {
            BackendError::Platform(format!("create Board store {}: {error}", root.display()))
        })?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn space_directory(&self, space_id: &str) -> BackendResult<PathBuf> {
        validate_component(space_id, "Space ID")?;
        Ok(self.root.join(space_id))
    }

    fn board_path(&self, space_id: &str, board_id: &str) -> BackendResult<PathBuf> {
        validate_component(board_id, "Board ID")?;
        Ok(self
            .space_directory(space_id)?
            .join(format!("{board_id}.html")))
    }
}

impl BoardStore for LocalBoardStore {
    fn list(&self, space_id: &str) -> BackendResult<Vec<BoardSummaryDto>> {
        let directory = self.space_directory(space_id)?;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(BackendError::Platform(format!(
                    "list Board directory {}: {error}",
                    directory.display()
                )));
            }
        };
        let mut boards = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| BackendError::Platform(error.to_string()))?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("html")
            {
                continue;
            }
            let Some(board_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if validate_component(board_id, "Board ID").is_err() {
                continue;
            }
            let document = read_document(space_id, board_id, &path)?;
            boards.push(BoardSummaryDto {
                id: document.id,
                space_id: document.space_id,
                title: document.title,
                revision: document.revision,
            });
        }
        boards.sort_by(|left, right| {
            left.title
                .to_lowercase()
                .cmp(&right.title.to_lowercase())
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(boards)
    }

    fn read(&self, space_id: &str, board_id: &str) -> BackendResult<BoardDocumentDto> {
        read_document(space_id, board_id, &self.board_path(space_id, board_id)?)
    }

    fn put(
        &self,
        space_id: &str,
        board_id: Option<&str>,
        html: &str,
        expected_revision: Option<&str>,
    ) -> BackendResult<BoardDocumentDto> {
        validate_html(html)?;
        let board_id = board_id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        validate_component(&board_id, "Board ID")?;
        let directory = self.space_directory(space_id)?;
        fs::create_dir_all(&directory).map_err(|error| {
            BackendError::Platform(format!(
                "create Board directory {}: {error}",
                directory.display()
            ))
        })?;
        let path = self.board_path(space_id, &board_id)?;
        if path.exists() {
            let current = read_document(space_id, &board_id, &path)?;
            if let Some(expected) = expected_revision
                && current.revision != expected
            {
                return Err(BackendError::Conflict(format!(
                    "Board {board_id} changed since revision {expected}"
                )));
            }
        } else if expected_revision.is_some() {
            return Err(BackendError::NotFound(format!("Board {board_id}")));
        }
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .map_err(|error| BackendError::Platform(format!("open Board file: {error}")))?;
        file.write_all(html.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| BackendError::Platform(format!("write Board file: {error}")))?;
        read_document(space_id, &board_id, &path)
    }
}

fn read_document(space_id: &str, board_id: &str, path: &Path) -> BackendResult<BoardDocumentDto> {
    let bytes = fs::read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            BackendError::NotFound(format!("Board {board_id}"))
        } else {
            BackendError::Platform(format!("read Board {board_id}: {error}"))
        }
    })?;
    if bytes.len() > MAX_BOARD_BYTES {
        return Err(BackendError::Invalid(format!(
            "Board {board_id} exceeds the 2 MiB limit"
        )));
    }
    let html = String::from_utf8(bytes)
        .map_err(|_| BackendError::Invalid(format!("Board {board_id} is not UTF-8")))?;
    validate_html(&html)?;
    Ok(BoardDocumentDto {
        id: board_id.to_string(),
        space_id: space_id.to_string(),
        title: html_title(&html),
        revision: content_revision(html.as_bytes()),
        html,
    })
}

fn validate_component(value: &str, label: &str) -> BackendResult<()> {
    if value.is_empty()
        || value.len() > MAX_BOARD_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BackendError::Invalid(format!(
            "{label} must contain only letters, numbers, hyphens, and underscores"
        )));
    }
    Ok(())
}

fn validate_html(html: &str) -> BackendResult<()> {
    if html.is_empty() || html.len() > MAX_BOARD_BYTES {
        return Err(BackendError::Invalid(
            "Board HTML must contain 1 byte through 2 MiB".into(),
        ));
    }
    let lowercase = html.to_ascii_lowercase();
    if !lowercase.contains("<html") || !lowercase.contains("</html>") {
        return Err(BackendError::Invalid(
            "Board content must be a complete HTML document".into(),
        ));
    }
    Ok(())
}

fn html_title(html: &str) -> String {
    let lowercase = html.to_ascii_lowercase();
    let Some(open) = lowercase.find("<title") else {
        return "Board".into();
    };
    let Some(content_start) = lowercase[open..].find('>').map(|index| open + index + 1) else {
        return "Board".into();
    };
    let Some(content_end) = lowercase[content_start..]
        .find("</title>")
        .map(|index| content_start + index)
    else {
        return "Board".into();
    };
    let title = html[content_start..content_end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title = title
        .chars()
        .take(MAX_BOARD_TITLE_CHARACTERS)
        .collect::<String>();
    if title.is_empty() {
        "Board".into()
    } else {
        title
    }
}

fn content_revision(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    format!("{:x}-{hash:x}", bytes.len())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn stores_lists_and_updates_a_single_html_board() {
        let root = tempdir().unwrap();
        let store = LocalBoardStore::open(root.path().join("boards")).unwrap();
        let first = store
            .put(
                "space-1",
                Some("architecture"),
                "<!doctype html><html><head><title>Architecture</title></head><body><button>Go</button></body></html>",
                None,
            )
            .unwrap();
        assert_eq!(first.title, "Architecture");
        assert_eq!(store.list("space-1").unwrap().len(), 1);

        let second = store
            .put(
                "space-1",
                Some("architecture"),
                "<html><head><title>Architecture v2</title></head><body></body></html>",
                Some(&first.revision),
            )
            .unwrap();
        assert_eq!(second.title, "Architecture v2");
        assert_ne!(second.revision, first.revision);
    }

    #[test]
    fn rejects_stale_updates_and_unsafe_ids() {
        let root = tempdir().unwrap();
        let store = LocalBoardStore::open(root.path().join("boards")).unwrap();
        store
            .put("space-1", Some("board"), "<html><body></body></html>", None)
            .unwrap();
        assert!(
            store
                .put(
                    "space-1",
                    Some("board"),
                    "<html><body>changed</body></html>",
                    Some("stale"),
                )
                .is_err()
        );
        assert!(store.read("space-1", "../board").is_err());
    }
}
