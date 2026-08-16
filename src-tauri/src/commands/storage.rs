/// Local filesystem storage for notes.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::settings;

/// Get the root notes directory.
/// When `use_directory_as_root` is enabled and a custom directory is set,
/// the custom path is used directly without appending a subfolder.
pub fn stik_root() -> Result<PathBuf, String> {
    let custom = settings::load_settings_from_file()
        .ok()
        .filter(|s| !s.notes_directory.is_empty())
        .and_then(|s| {
            let p = PathBuf::from(&s.notes_directory);
            if p.is_absolute() {
                Some((p, s.use_directory_as_root))
            } else {
                None
            }
        });

    let path = match custom {
        Some((dir, true)) => dir,
        Some((dir, false)) => dir.join("Stik"),
        None => {
            let docs = dirs::document_dir().ok_or("Could not find Documents directory")?;
            docs.join("Stik")
        }
    };
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

// ── File Operations ───────────────────────────────────────────────

pub fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

pub fn write_bytes(path: &str, data: &[u8]) -> Result<(), String> {
    fs::write(path, data).map_err(|e| e.to_string())
}

pub fn delete_file(path: &str) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| e.to_string())
}

pub fn move_file(src: &str, dst: &str) -> Result<(), String> {
    fs::rename(src, dst).map_err(|e| e.to_string())
}

pub fn copy_file(src: &str, dst: &str) -> Result<(), String> {
    fs::copy(src, dst).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn ensure_dir(path: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

pub fn remove_dir_all(path: &str) -> Result<(), String> {
    fs::remove_dir_all(path).map_err(|e| e.to_string())
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

pub fn is_dir(path: &str) -> bool {
    PathBuf::from(path).is_dir()
}
