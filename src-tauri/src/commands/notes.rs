use base64::Engine;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

use super::index::NoteIndex;
use super::storage::{self, notes_root};
use crate::state::{AppState, LastSavedNote};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSaved {
    pub path: String,
    pub filename: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NoteInfo {
    pub path: String,
    pub filename: String,
    pub content: String,
    pub created: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub filename: String,
    pub title: String,
    pub snippet: String,
    pub created: String,
}

/// Generate a slug from content (first 5 words, max 40 chars)
fn generate_slug(content: &str) -> String {
    let cleaned: String = content
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect();

    let slug: String = cleaned
        .split_whitespace()
        .take(5)
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();

    if slug.len() > 40 {
        let mut end = 40;
        while end > 0 && !slug.is_char_boundary(end) {
            end -= 1;
        }
        slug[..end].to_string()
    } else if slug.is_empty() {
        "note".to_string()
    } else {
        slug
    }
}

/// Generate timestamp-based filename with UUID suffix to prevent collisions
fn generate_filename(content: &str) -> String {
    let now = Local::now();
    let timestamp = now.format("%Y%m%d-%H%M%S").to_string();
    let slug = generate_slug(content);
    let suffix = &uuid::Uuid::new_v4().to_string()[..4];
    format!("{}-{}-{}.md", timestamp, slug, suffix)
}

fn is_break_placeholder_line(line: &str) -> bool {
    line.eq_ignore_ascii_case("<br>")
        || line.eq_ignore_ascii_case("<br/>")
        || line.eq_ignore_ascii_case("<br />")
}

pub fn is_effectively_empty_markdown(content: &str) -> bool {
    content.lines().all(|line| {
        let trimmed = line.trim();
        trimmed.is_empty() || is_break_placeholder_line(trimmed)
    })
}

/// Core save logic, callable from other Rust modules without Tauri State
pub fn save_note_inner(content: String) -> Result<NoteSaved, String> {
    // Don't save empty notes
    if is_effectively_empty_markdown(&content) {
        return Ok(NoteSaved {
            path: String::new(),
            filename: String::new(),
        });
    }

    let root = notes_root()?;
    let filename = generate_filename(&content);
    let file_path = root.join(&filename);

    storage::write_file(&file_path.to_string_lossy(), &content)?;

    Ok(NoteSaved {
        path: file_path.to_string_lossy().to_string(),
        filename,
    })
}

/// Post-save side effects: indexing and last_saved_note tracking.
pub fn post_save_processing(app: &AppHandle, result: &NoteSaved) {
    if result.path.is_empty() {
        return;
    }

    let index = app.state::<NoteIndex>();
    index.add(&result.path);

    let state = app.state::<AppState>();
    let mut last = state
        .last_saved_note
        .lock()
        .unwrap_or_else(|e: std::sync::PoisonError<_>| e.into_inner());
    *last = Some(LastSavedNote {
        path: result.path.clone(),
    });
}

#[tauri::command]
pub fn save_note(app: AppHandle, content: String) -> Result<NoteSaved, String> {
    let result = save_note_inner(content)?;
    post_save_processing(&app, &result);
    Ok(result)
}

#[tauri::command]
pub fn list_notes(index: State<'_, NoteIndex>) -> Result<Vec<NoteInfo>, String> {
    let entries = index.list()?;

    Ok(entries
        .into_iter()
        .map(|e| NoteInfo {
            path: e.path,
            filename: e.filename,
            content: e.preview,
            created: e.created,
        })
        .collect())
}

#[tauri::command]
pub fn search_notes(
    query: String,
    index: State<'_, NoteIndex>,
) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let results = index.search(&query)?;

    Ok(results
        .into_iter()
        .map(|(entry, snippet)| SearchResult {
            path: entry.path,
            filename: entry.filename,
            title: entry.title,
            snippet,
            created: entry.created,
        })
        .collect())
}

pub fn get_note_content_inner(path: &str) -> Result<String, String> {
    let root = notes_root()?;
    let note_path = PathBuf::from(path);

    // Canonicalize both sides to handle symlinks (/tmp → /private/tmp),
    // trailing slashes, and relative-component differences that would
    // otherwise break PathBuf::starts_with's component-wise compare.
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let canonical_note = note_path
        .canonicalize()
        .unwrap_or_else(|_| note_path.clone());

    if !canonical_note.starts_with(&canonical_root) {
        return Err(format!(
            "Note is outside the drafts folder.\n  note: {}\n  root: {}",
            note_path.display(),
            root.display()
        ));
    }
    if !storage::path_exists(path) {
        return Err(format!("Note file not found: {}", note_path.display()));
    }

    storage::read_file(path)
}

#[tauri::command]
pub fn get_note_content(path: String) -> Result<String, String> {
    get_note_content_inner(&path)
}

#[tauri::command]
pub fn update_note(
    path: String,
    content: String,
    index: State<'_, NoteIndex>,
) -> Result<NoteSaved, String> {
    let root = notes_root()?;
    let note_path = PathBuf::from(&path);
    let in_root = note_path.starts_with(&root);

    // For drafts opened from Finder, allow saving external markdown files too.
    if !in_root {
        let is_markdown = note_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
            .unwrap_or(false);
        if !is_markdown {
            return Err(
                "Invalid path: only markdown files can be edited outside the drafts folder"
                    .to_string(),
            );
        }
    }

    // Check file exists
    if !storage::path_exists(&path) {
        return Err("Note file does not exist".to_string());
    }

    // Inside the drafts folder, empty content deletes the note.
    if in_root && is_effectively_empty_markdown(&content) {
        storage::delete_file(&path).map_err(|e| format!("Failed to delete note: {}", e))?;
        index.remove(&path);
        return Ok(NoteSaved {
            path: String::new(),
            filename: String::new(),
        });
    }

    let filename = note_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // Write updated content
    storage::write_file(&path, &content)?;

    if in_root {
        // Re-index with updated content
        index.add(&path);
    }

    Ok(NoteSaved {
        path: note_path.to_string_lossy().to_string(),
        filename,
    })
}

#[tauri::command]
pub fn delete_note(
    app: AppHandle,
    path: String,
    index: State<'_, NoteIndex>,
) -> Result<bool, String> {
    let root = notes_root()?;
    let note_path = PathBuf::from(&path);

    // Validate path is within the drafts folder
    if !note_path.starts_with(&root) {
        return Err("Invalid path: note must be within the drafts folder".to_string());
    }

    // Check file exists
    if !storage::path_exists(&path) {
        return Err("Note file does not exist".to_string());
    }

    // Delete referenced .assets/ images
    if let Ok(content) = storage::read_file(&path) {
        let dir = note_path.parent().unwrap_or(&root);
        delete_note_assets(&content, dir);
    }

    // Delete the file
    storage::delete_file(&path).map_err(|e| format!("Failed to delete note: {}", e))?;
    index.remove(&path);

    // Notify any open windows so they can reset themselves
    let _ = app.emit("note-deleted", &path);

    Ok(true)
}

/// Detect image format from a data-URL prefix or raw base64 magic bytes.
/// Returns file extension (png, jpg, gif, webp). Defaults to "png".
fn detect_image_ext(data: &str) -> &'static str {
    let lower = data.to_ascii_lowercase();
    if lower.starts_with("data:image/jpeg") || lower.starts_with("data:image/jpg") {
        return "jpg";
    }
    if lower.starts_with("data:image/gif") {
        return "gif";
    }
    if lower.starts_with("data:image/webp") {
        return "webp";
    }
    if lower.starts_with("data:image/png") {
        return "png";
    }
    "png"
}

/// Extract `.assets/<filename>` references from markdown content.
pub(crate) fn extract_asset_filenames(content: &str) -> Vec<String> {
    let re_pattern = ".assets/";
    let mut filenames = Vec::new();
    for line in content.lines() {
        let mut search = line;
        while let Some(idx) = search.find(re_pattern) {
            let after = &search[idx + re_pattern.len()..];
            // Filename ends at ), ", ', whitespace, or end of string
            let end = after
                .find(|c: char| c == ')' || c == '"' || c == '\'' || c.is_whitespace())
                .unwrap_or(after.len());
            let name = &after[..end];
            if !name.is_empty() {
                filenames.push(name.to_string());
            }
            search = &after[end..];
        }
    }
    filenames
}

/// Delete `.assets/` files referenced by a note.
pub(crate) fn delete_note_assets(content: &str, folder_path: &std::path::Path) {
    let filenames = extract_asset_filenames(content);
    let assets_dir = folder_path.join(".assets");
    for name in filenames {
        let path = assets_dir.join(&name);
        let _ = storage::delete_file(&path.to_string_lossy());
    }
}

fn is_supported_image_ext(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif"
    )
}

/// Save an image (base64-encoded) into the drafts `.assets/` directory.
/// Returns `(absolute_path, relative_markdown_ref)`.
#[tauri::command]
pub fn save_note_image(image_data: String) -> Result<(String, String), String> {
    let ext = detect_image_ext(&image_data);

    // Strip the data-URL prefix if present
    let raw_b64 = if let Some(idx) = image_data.find(",") {
        &image_data[idx + 1..]
    } else {
        &image_data
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw_b64)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    let root = notes_root()?;
    let assets_dir = root.join(".assets");
    storage::ensure_dir(&assets_dir.to_string_lossy())
        .map_err(|e| format!("Failed to create .assets dir: {}", e))?;

    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let file_path = assets_dir.join(&filename);

    storage::write_bytes(&file_path.to_string_lossy(), &bytes)
        .map_err(|e| format!("Failed to write image: {}", e))?;

    let abs = file_path.to_string_lossy().to_string();
    let rel = format!(".assets/{}", filename);
    Ok((abs, rel))
}

#[tauri::command]
pub fn save_note_image_from_path(file_path: String) -> Result<(String, String), String> {
    let source_path = PathBuf::from(&file_path);
    if !source_path.is_absolute() {
        return Err("Image path must be absolute".to_string());
    }
    if !source_path.exists() || !source_path.is_file() {
        return Err("Dropped image file does not exist".to_string());
    }

    let ext = source_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "Image file extension is missing".to_string())?;
    if !is_supported_image_ext(&ext) {
        return Err("Dropped file is not a supported image".to_string());
    }

    let root = notes_root()?;
    let assets_dir = root.join(".assets");
    storage::ensure_dir(&assets_dir.to_string_lossy())
        .map_err(|e| format!("Failed to create .assets dir: {}", e))?;

    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let destination_path = assets_dir.join(&filename);
    storage::copy_file(&file_path, &destination_path.to_string_lossy())
        .map_err(|e| format!("Failed to copy dropped image: {}", e))?;

    let abs = destination_path.to_string_lossy().to_string();
    let rel = format!(".assets/{}", filename);
    Ok((abs, rel))
}

#[cfg(test)]
mod tests {
    use super::is_effectively_empty_markdown;

    #[test]
    fn placeholder_breaks_only_are_treated_as_empty() {
        assert!(is_effectively_empty_markdown("<br>\n\n<br />\n"));
    }

    #[test]
    fn real_content_with_placeholders_is_not_empty() {
        assert!(!is_effectively_empty_markdown("hello\n\n<br>\n"));
    }
}
