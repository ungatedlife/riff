/// The publish ritual: stamp a finished riff with frontmatter and move it —
/// images included — from the drafts folder into the configured vault folder.
use chrono::{Local, SecondsFormat};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

use super::cursor_positions;
use super::index::NoteIndex;
use super::notes;
use super::settings;
use super::storage::{self, notes_root};
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct PublishedInfo {
    pub vault_path: String,
    pub title: String,
    pub slug: String,
    pub word_count: usize,
    pub assets_copied: usize,
}

/// Strip block and inline markdown markers from a title candidate line.
fn strip_markdown_markers(line: &str) -> String {
    let mut s = line.trim();
    loop {
        let mut next = s.trim_start_matches('#').trim_start_matches('>').trim();
        if let Some(rest) = next.strip_prefix("- ") {
            next = rest.trim();
        }
        if next == s {
            break;
        }
        s = next;
    }
    s.chars()
        .filter(|c| !matches!(c, '*' | '_' | '`' | '~' | '='))
        .collect::<String>()
        .trim()
        .to_string()
}

fn truncate_title(s: &str) -> String {
    let base = if s.is_empty() { "Untitled" } else { s };
    base.chars()
        .take(80)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Derive the riff's title and body. A leading ATX H1 becomes the title and
/// is removed from the body (the frontmatter carries it — no double titles
/// downstream); otherwise the first non-blank line is the title and the body
/// stays untouched.
fn derive_title(content: &str) -> (String, String) {
    let first_non_blank = content
        .lines()
        .enumerate()
        .find(|(_, l)| !l.trim().is_empty());

    let Some((idx, first_line)) = first_non_blank else {
        return ("Untitled".to_string(), content.to_string());
    };

    let trimmed = first_line.trim();
    if let Some(heading) = trimmed.strip_prefix("# ") {
        let title = truncate_title(heading.trim());
        let mut body_lines: Vec<&str> = content.lines().skip(idx + 1).collect();
        if body_lines
            .first()
            .map(|l| l.trim().is_empty())
            .unwrap_or(false)
        {
            body_lines.remove(0);
        }
        (title, body_lines.join("\n"))
    } else {
        (
            truncate_title(&strip_markdown_markers(trimmed)),
            content.to_string(),
        )
    }
}

/// The published file carries the riff's *title* as its name — in Obsidian
/// the filename IS the note's name, so `# On riffs` becomes `On riffs.md`
/// and `[[On riffs]]` resolves naturally. Only filesystem- and
/// Obsidian-hostile characters are dropped.
fn sanitize_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            // Filesystem-reserved (macOS/Windows) + Obsidian link breakers.
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | '#' | '^' => ' ',
            _ => c,
        })
        .collect();

    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c| c == '.' || c == ' ').to_string();

    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed
    }
}

fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = true; // suppress a leading dash
    for c in title.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                slug.push(lc);
            }
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
        if slug.len() >= 60 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "riff".to_string()
    } else {
        slug
    }
}

/// First free `<name>.md`, `<name> 2.md`, … `<name> 99.md` in the vault
/// (space-number, the way Obsidian dedupes duplicate note names).
fn resolve_vault_path(vault: &Path, name: &str) -> Result<PathBuf, String> {
    let base = vault.join(format!("{}.md", name));
    if !base.exists() {
        return Ok(base);
    }
    for n in 2..100 {
        let candidate = vault.join(format!("{} {}.md", name, n));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Too many published riffs with this title".to_string())
}

/// Copy referenced draft images into `<vault>/assets/` and rewrite the body's
/// `.assets/` refs to `assets/` — Obsidian ignores dot-directories, so the
/// links would otherwise be dead inside the vault.
fn rewrite_and_copy_assets(
    body: &str,
    drafts_root: &Path,
    vault: &Path,
) -> Result<(String, usize), String> {
    let filenames = notes::extract_asset_filenames(body);
    if filenames.is_empty() {
        return Ok((body.to_string(), 0));
    }

    let src_dir = drafts_root.join(".assets");
    let dst_dir = vault.join("assets");
    let mut copied = 0;
    for name in &filenames {
        let src = src_dir.join(name);
        if !src.exists() {
            continue;
        }
        storage::ensure_dir(&dst_dir.to_string_lossy())?;
        storage::copy_file(
            &src.to_string_lossy(),
            &dst_dir.join(name).to_string_lossy(),
        )?;
        copied += 1;
    }
    Ok((body.replace(".assets/", "assets/"), copied))
}

fn frontmatter(title: &str) -> String {
    let escaped = title.replace('\\', "\\\\").replace('"', "\\\"");
    let date = Local::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    format!("---\ntitle: \"{}\"\ndate: {}\n---\n\n", escaped, date)
}

#[tauri::command]
pub fn publish_riff(
    app: AppHandle,
    path: String,
    index: State<'_, NoteIndex>,
) -> Result<PublishedInfo, String> {
    let settings = settings::load_settings_from_file()?;
    let vault_dir = settings
        .vault_dir
        .filter(|v| !v.trim().is_empty())
        .ok_or("No vault folder configured")?;
    let vault = PathBuf::from(&vault_dir);
    if !vault.is_dir() {
        return Err(format!("Vault folder does not exist: {}", vault.display()));
    }

    let root = notes_root()?;
    let note_path = PathBuf::from(&path);
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let canonical_note = note_path
        .canonicalize()
        .unwrap_or_else(|_| note_path.clone());
    if !canonical_note.starts_with(&canonical_root) {
        return Err("Only drafts inside the drafts folder can be published".to_string());
    }

    let content = storage::read_file(&path)?;
    if notes::is_effectively_empty_markdown(&content) {
        return Err("Nothing to publish".to_string());
    }

    let (title, body) = derive_title(&content);
    let slug = slugify(&title);
    let filename = sanitize_filename(&title);
    let target = resolve_vault_path(&vault, &filename)?;
    let (rewritten, assets_copied) = rewrite_and_copy_assets(&body, &root, &vault)?;

    let word_count = rewritten.split_whitespace().count();
    let final_content = format!(
        "{}{}",
        frontmatter(&title),
        rewritten.trim_start_matches('\n')
    );

    storage::write_file(&target.to_string_lossy(), &final_content)?;

    // The riff has left the drafts folder: remove the draft, its assets,
    // its index entry, and its cursor position.
    notes::delete_note_assets(&content, &root);
    let _ = storage::delete_file(&path);
    index.remove(&path);
    let _ = cursor_positions::remove_cursor_position(path.clone());

    {
        let state = app.state::<AppState>();
        let mut last = state
            .last_saved_note
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if last.as_ref().map(|n| n.path == path).unwrap_or(false) {
            *last = None;
        }
    }

    let _ = app.emit("files-changed", vec![path.clone()]);

    Ok(PublishedInfo {
        vault_path: target.to_string_lossy().to_string(),
        title,
        slug,
        word_count,
        assets_copied,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        derive_title, frontmatter, resolve_vault_path, rewrite_and_copy_assets, sanitize_filename,
        slugify,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("riff-publish-{}-{}", tag, unique));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn h1_becomes_title_and_leaves_the_body() {
        let (title, body) = derive_title("# On riffs\n\nThey move the conversation.");
        assert_eq!(title, "On riffs");
        assert_eq!(body, "They move the conversation.");
    }

    #[test]
    fn plain_first_line_is_title_and_body_is_untouched() {
        let content = "Just a thought.\n\nMore of it.";
        let (title, body) = derive_title(content);
        assert_eq!(title, "Just a thought.");
        assert_eq!(body, content);
    }

    #[test]
    fn markdown_markers_are_stripped_from_derived_titles() {
        let (title, _) = derive_title("**Bold** and *loose* thinking");
        assert_eq!(title, "Bold and loose thinking");
    }

    #[test]
    fn empty_content_falls_back_to_untitled() {
        let (title, _) = derive_title("\n\n");
        assert_eq!(title, "Untitled");
    }

    #[test]
    fn slugify_joins_alphanumeric_runs() {
        assert_eq!(
            slugify("On riffs, & conversation!"),
            "on-riffs-conversation"
        );
        assert_eq!(slugify("???"), "riff");
    }

    #[test]
    fn frontmatter_escapes_quotes() {
        let fm = frontmatter(r#"A "quoted" title"#);
        assert!(fm.starts_with("---\ntitle: \"A \\\"quoted\\\" title\"\ndate: "));
        assert!(fm.ends_with("---\n\n"));
    }

    #[test]
    fn filenames_keep_the_human_title() {
        assert_eq!(sanitize_filename("On riffs"), "On riffs");
        assert_eq!(
            sanitize_filename("Ship it: thoughts & questions?"),
            "Ship it thoughts & questions"
        );
        assert_eq!(
            sanitize_filename("[[Nested]] #tags ^blocks"),
            "Nested tags blocks"
        );
        assert_eq!(sanitize_filename("///"), "Untitled");
        assert_eq!(sanitize_filename("..."), "Untitled");
    }

    #[test]
    fn vault_path_resolution_skips_existing_files_obsidian_style() {
        let vault = temp_dir("collide");
        fs::write(vault.join("On riffs.md"), "x").unwrap();
        let next = resolve_vault_path(&vault, "On riffs").unwrap();
        assert_eq!(next.file_name().unwrap(), "On riffs 2.md");
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn assets_are_copied_and_refs_rewritten() {
        let drafts = temp_dir("drafts");
        let vault = temp_dir("vault");
        fs::create_dir_all(drafts.join(".assets")).unwrap();
        fs::write(drafts.join(".assets/pic.png"), b"png").unwrap();

        let body = "Look: ![](.assets/pic.png)";
        let (rewritten, copied) = rewrite_and_copy_assets(body, &drafts, &vault).unwrap();

        assert_eq!(copied, 1);
        assert_eq!(rewritten, "Look: ![](assets/pic.png)");
        assert!(vault.join("assets/pic.png").exists());

        let _ = fs::remove_dir_all(&drafts);
        let _ = fs::remove_dir_all(&vault);
    }
}
