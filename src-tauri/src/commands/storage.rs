/// Local filesystem storage for drafts.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::path::PathBuf;

use super::settings;

/// Get the drafts directory: the configured `drafts_dir`, or ~/Documents/Riff.
pub fn notes_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var("RIFF_TEST_HOME").ok().or_else(|| option_env!("RIFF_TEST_HOME").map(String::from)) {
        let drafts = PathBuf::from(root).join("Drafts");
        fs::create_dir_all(&drafts).map_err(|e| e.to_string())?;
        return Ok(drafts);
    }
    let custom = settings::load_settings_from_file()
        .ok()
        .and_then(|s| s.drafts_dir)
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());

    let path = match custom {
        Some(dir) => dir,
        None => {
            let docs = dirs::document_dir().ok_or("Could not find Documents directory")?;
            docs.join("Riff")
        }
    };
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn get_drafts_directory() -> Result<String, String> {
    let path = notes_root()?;
    Ok(path.to_string_lossy().to_string())
}

// ── File Operations ───────────────────────────────────────────────

pub fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    atomic_write(std::path::Path::new(path), content.as_bytes(), false)
}


static WRITE_ID: AtomicU64 = AtomicU64::new(0);

/// Stage beside the destination, flush, then publish a complete file.
/// `new_only` uses a hard link so a racing writer can never be overwritten.
pub fn atomic_write(path: &std::path::Path, bytes: &[u8], new_only: bool) -> Result<(), String> {
    let target = if !new_only && path.exists() {
        path.canonicalize().map_err(|e| e.to_string())?
    } else { path.to_path_buf() };
    let parent = target.parent().ok_or("File has no parent folder")?;
    let temporary = parent.join(format!(".riff-write-{}-{}", std::process::id(), WRITE_ID.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        if let Ok(metadata) = fs::metadata(&target) { file.set_permissions(metadata.permissions())?; }
        file.write_all(bytes)?;
        file.sync_all()?;
        if new_only { fs::hard_link(&temporary, &target)?; } else { fs::rename(&temporary, &target)?; }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result.map_err(|e| format!("Could not save {}: {}", target.display(), e))
}

pub fn write_bytes(path: &str, data: &[u8]) -> Result<(), String> {
    fs::write(path, data).map_err(|e| e.to_string())
}

pub fn delete_file(path: &str) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| e.to_string())
}

pub fn copy_file(src: &str, dst: &str) -> Result<(), String> {
    fs::copy(src, dst).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn ensure_dir(path: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified: Option<String>,
}

pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    Ok(entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok().map(|t| {
                let dt: chrono::DateTime<chrono::Local> = t.into();
                dt.to_rfc3339()
            });
            Some(DirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_directory: metadata.is_dir(),
                size: metadata.len(),
                modified,
            })
        })
        .collect())
}

pub fn path_exists(path: &str) -> bool {
    PathBuf::from(path).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_file_writes_never_overwrite_an_existing_note() {
        let folder = std::env::temp_dir().join(format!("riff-atomic-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("existing.md");
        fs::write(&path, "original").unwrap();
        assert!(atomic_write(&path, b"replacement", true).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        atomic_write(&path, b"intentional update", false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "intentional update");
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&folder);
    }
}
