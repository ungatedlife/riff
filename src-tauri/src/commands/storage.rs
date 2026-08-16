/// Local filesystem storage for drafts.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::settings;

/// Get the drafts directory: the configured `drafts_dir`, or ~/Documents/Riff.
pub fn notes_root() -> Result<PathBuf, String> {
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
    fs::write(path, content).map_err(|e| e.to_string())
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
