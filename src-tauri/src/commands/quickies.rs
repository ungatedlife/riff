/// Quickies: fleeting thoughts appended to one running note in the vault.
///
/// The running note is an ordinary markdown file, so "sending a thought to
/// Obsidian" is just appending a timestamped block to that file on disk —
/// Obsidian watches its vault and picks the change up immediately.
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::notes;
use super::settings;
use super::storage;

#[derive(Debug, Serialize, Deserialize)]
pub struct QuickieAppended {
    pub file_path: String,
}

/// The configured quickies note, or `<vault>/Quickies.md` when only a vault
/// is set (created on first capture).
fn resolve_quickies_file() -> Result<PathBuf, String> {
    let s = settings::load_settings_from_file()?;

    if let Some(file) = s.quickies_file.filter(|f| !f.trim().is_empty()) {
        return Ok(PathBuf::from(file));
    }

    if let Some(vault) = s.vault_dir.filter(|v| !v.trim().is_empty()) {
        return Ok(PathBuf::from(vault).join("Quickies.md"));
    }

    Err("No quickies note configured".to_string())
}

/// Append a timestamped entry, keeping exactly one blank line between blocks.
fn build_appended(existing: &str, content: &str) -> String {
    let stamp = Local::now().format("%Y-%m-%d %H:%M").to_string();
    let entry = format!("**{}**\n{}\n", stamp, content.trim());

    let trimmed = existing.trim_end();
    if trimmed.is_empty() {
        entry
    } else {
        format!("{}\n\n{}", trimmed, entry)
    }
}

#[tauri::command]
pub fn append_quickie(content: String) -> Result<QuickieAppended, String> {
    if notes::is_effectively_empty_markdown(&content) {
        return Err("Nothing to capture".to_string());
    }

    let target = resolve_quickies_file()?;
    if let Some(parent) = target.parent() {
        storage::ensure_dir(&parent.to_string_lossy())?;
    }

    let path_str = target.to_string_lossy().to_string();
    let existing = if storage::path_exists(&path_str) {
        storage::read_file(&path_str)?
    } else {
        String::new()
    };

    storage::write_file(&path_str, &build_appended(&existing, &content))?;

    Ok(QuickieAppended {
        file_path: path_str,
    })
}

#[cfg(test)]
mod tests {
    use super::build_appended;

    #[test]
    fn first_entry_starts_the_file_without_leading_whitespace() {
        let out = build_appended("", "a thought");
        assert!(out.starts_with("**"));
        assert!(out.ends_with("a thought\n"));
    }

    #[test]
    fn entries_are_separated_by_one_blank_line() {
        let existing = "**2026-08-17 09:00**\nfirst\n";
        let out = build_appended(existing, "second");
        assert!(out.contains("first\n\n**"));
        assert!(out.ends_with("second\n"));
    }

    #[test]
    fn messy_trailing_whitespace_is_normalized() {
        let existing = "**2026-08-17 09:00**\nfirst\n\n\n\n";
        let out = build_appended(existing, "  second  ");
        assert!(out.contains("first\n\n**"));
        assert!(out.ends_with("second\n"));
    }
}
