/// The publish ritual: stamp a finished riff with the vault's own front
/// matter and move it — images included — from the drafts folder into the
/// configured vault folder. Sparks skip the drafts folder entirely: a line
/// or three, written straight into `Sparks/`, shipped.
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

use super::connections::{self, Connections, Quote};
use super::cursor_positions;
use super::frontmatter::{yaml_list, yaml_scalar};
use super::index::NoteIndex;
use super::notes;
use super::settings;
use super::site;
use super::storage::{self, notes_root};
use super::vault;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct PublishedInfo {
    pub vault_path: String,
    pub title: String,
    pub word_count: usize,
    pub assets_copied: usize,
    /// `shipped` or `draft` — what the note's status says.
    pub status: String,
    /// Why the site publish didn't start, if it didn't (no site folder,
    /// turned off, or the piece stayed a draft). None = it's running.
    pub site_publish_skipped: Option<String>,
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

/// Titles cap at this many characters, cut at a word boundary so a riff
/// that opens with a long sentence never gets a filename ending mid-word.
const TITLE_MAX_CHARS: usize = 80;

fn truncate_title(s: &str) -> String {
    let base = if s.is_empty() { "Untitled" } else { s };
    if base.chars().count() <= TITLE_MAX_CHARS {
        return base.trim_end().to_string();
    }
    let cut: String = base.chars().take(TITLE_MAX_CHARS).collect();
    let next_is_space = base
        .chars()
        .nth(TITLE_MAX_CHARS)
        .map(char::is_whitespace)
        .unwrap_or(true);
    let at_boundary = if next_is_space {
        cut
    } else {
        match cut.rfind(char::is_whitespace) {
            Some(idx) if idx > 0 => cut[..idx].to_string(),
            _ => cut,
        }
    };
    at_boundary.trim_end().to_string()
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
        // `# **Bold**` is a bold heading in the room, not a title with
        // asterisks in it.
        let title = truncate_title(&strip_markdown_markers(heading));
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
    let mut filenames = notes::extract_asset_filenames(body);
    filenames.sort_by_key(|name| std::cmp::Reverse(name.len()));
    filenames.dedup();
    if filenames.is_empty() {
        return Ok((body.to_string(), 0));
    }

    let src_dir = drafts_root.join(".assets").canonicalize().map_err(|_| {
        "The draft's images folder is missing. Your draft has been kept.".to_string()
    })?;
    let dst_dir = vault.join("assets");
    let mut sources = Vec::new();
    // Validate and read every image before writing any vault assets.
    for name in &filenames {
        let part = Path::new(name);
        if part.components().count() != 1
            || !matches!(
                part.components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err("An image reference points outside the draft's images folder".to_string());
        }
        let src = src_dir
            .join(name)
            .canonicalize()
            .map_err(|_| format!("Image {} is missing. Your draft has been kept.", name))?;
        if !src.starts_with(&src_dir) {
            return Err("An image points outside the draft's images folder".to_string());
        }
        sources.push((name, std::fs::read(src).map_err(|e| e.to_string())?));
    }
    storage::ensure_dir(&dst_dir.to_string_lossy())?;
    let mut rewritten = body.to_string();
    let mut copied = 0;
    for (name, bytes) in sources {
        let mut destination = dst_dir.join(name);
        if destination.exists() && std::fs::read(&destination).map_err(|e| e.to_string())? != bytes
        {
            let stem = Path::new(name)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            let ext = Path::new(name)
                .extension()
                .unwrap_or_default()
                .to_string_lossy();
            let mut suffix = 2;
            loop {
                destination = dst_dir.join(format!("{}-{}.{}", stem, suffix, ext));
                if !destination.exists() {
                    break;
                }
                suffix += 1;
            }
        }
        if !destination.exists() {
            storage::atomic_write(&destination, &bytes, true)?;
            copied += 1;
        }
        let final_name = destination.file_name().unwrap().to_string_lossy();
        rewritten = rewritten.replace(
            &format!(".assets/{}", name),
            &format!("assets/{}", final_name),
        );
    }
    Ok((rewritten, copied))
}

fn status_word(ship: bool) -> &'static str {
    if ship {
        "shipped"
    } else {
        "draft"
    }
}

/// Exactly the vault's `Templates/Riff.md`, filled in. The note's name is
/// its title (Obsidian's rule, and the site's), so no `title:` line.
fn riff_frontmatter(c: &Connections, date: &str) -> String {
    format!(
        "---\ntype: riff\n{}{}{}{}{}---\n\n",
        yaml_list("status", &[status_word(c.ship).to_string()]),
        yaml_scalar("date", date),
        yaml_list("topics", &c.topics),
        yaml_list("riffs-on", &c.links),
        yaml_list("conversations", &c.conversations),
    )
}

/// Exactly the vault's `Templates/Spark.md`: shipped by default, stamped
/// with the minute it struck.
fn spark_frontmatter(c: &Connections, minute: &str) -> String {
    format!(
        "---\ntype: spark\n{}{}{}{}{}---\n\n",
        yaml_list("status", &["shipped".to_string()]),
        yaml_scalar("date", minute),
        yaml_list("sparked-by", &c.links),
        yaml_list("topics", &c.topics),
        yaml_list("conversations", &c.conversations),
    )
}

/// A spark with a passage attached reads like a quote tweet: his words,
/// a blank line, then the passage under them.
fn spark_body(words: &str, quote: Option<&Quote>) -> String {
    let words = words.trim();
    match quote {
        Some(quote) if words.is_empty() => quote.block(),
        Some(quote) => format!("{}\n\n{}", words, quote.block()),
        None => words.to_string(),
    }
}

/// A riff answers the passage, so the passage comes first: the quote, a
/// blank line, then his words.
fn riff_body(words: &str, quote: Option<&Quote>) -> String {
    let words = words.trim_start_matches('\n');
    match quote {
        Some(quote) if words.trim().is_empty() => format!("{}\n", quote.block()),
        Some(quote) => format!("{}\n\n{}", quote.block(), words),
        None => words.to_string(),
    }
}

/// Kick off the site publish for something that just shipped. Returns the
/// reason it didn't, if it didn't.
fn ship_to_site(app: &AppHandle, shipped: bool) -> Option<String> {
    if !shipped {
        return Some("Kept as a draft in the vault.".to_string());
    }
    let settings = match settings::load_settings_from_file() {
        Ok(s) => s,
        Err(e) => return Some(e),
    };
    // No script chosen: there is nothing to run, and nothing worth saying.
    if settings
        .site_dir
        .as_deref()
        .is_none_or(|d| d.trim().is_empty())
    {
        return None;
    }
    if !settings.auto_publish_site {
        return Some("Publishing is off in Settings.".to_string());
    }
    site::request_site_publish(app).err()
}

/// Words as the room counts them: tokens with at least one letter or digit,
/// so bullets and bare markers don't inflate the number.
fn count_words(body: &str) -> usize {
    body.split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count()
}

#[tauri::command]
pub fn publish_riff(
    app: AppHandle,
    path: String,
    connections: Option<Connections>,
    index: State<'_, NoteIndex>,
) -> Result<PublishedInfo, String> {
    let connections = connections.unwrap_or_default().normalized();
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

    // The title, the file name and the word count come from his words
    // alone. An attached passage only joins the body, below, once they are
    // settled.
    let (title, body) = derive_title(&content);
    let filename = sanitize_filename(&title);
    let target = resolve_vault_path(&vault, &filename)?;
    let (rewritten, assets_copied) = rewrite_and_copy_assets(&body, &root, &vault)?;

    let word_count = count_words(&rewritten);
    let date = Local::now().format("%Y-%m-%d").to_string();
    let final_content = format!(
        "{}{}",
        riff_frontmatter(&connections, &date),
        riff_body(&rewritten, connections.quote.as_ref())
    );

    storage::atomic_write(&target, final_content.as_bytes(), true)?;

    // The riff has left the drafts folder: remove the draft, its assets,
    // its index entry, its cursor position, and its connections.
    // Keep source images. Other unfinished riffs may reference the same files.
    // A future explicit cleanup can collect unreferenced assets safely.
    let _ = storage::delete_file(&path);
    index.remove(&path);
    let _ = cursor_positions::remove_cursor_position(path.clone());
    let _ = connections::remove_connections(path.clone());

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
    let site_publish_skipped = ship_to_site(&app, connections.ship);

    Ok(PublishedInfo {
        vault_path: target.to_string_lossy().to_string(),
        title,
        word_count,
        assets_copied,
        status: status_word(connections.ship).to_string(),
        site_publish_skipped,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SparkPublished {
    pub vault_path: String,
    /// The note's name — the spark's first line, as the vault names it.
    pub name: String,
    pub site_publish_skipped: Option<String>,
}

/// Write a spark note into the sparks folder. Returns the note's path and
/// name. A spark IS its first line: the vault names the note by it, the
/// body keeps the whole text (an opening `# heading` becomes the name and
/// leaves the body, like a riff). `text` is his words only: a passage
/// attached to the spark rides in `connections` and goes under them, so it
/// can never name the note or stand in for something to say.
fn write_spark(
    sparks: &Path,
    text: &str,
    connections: &Connections,
    minute: &str,
) -> Result<(PathBuf, String), String> {
    if notes::is_effectively_empty_markdown(text) {
        return Err("Nothing to spark".to_string());
    }
    storage::ensure_dir(&sparks.to_string_lossy())?;
    let (name, body) = derive_title(text);
    let filename = sanitize_filename(&name);
    let target = resolve_vault_path(sparks, &filename)?;
    let final_content = format!(
        "{}{}\n",
        spark_frontmatter(connections, minute),
        spark_body(&body, connections.quote.as_ref())
    );
    storage::atomic_write(&target, final_content.as_bytes(), true)?;
    Ok((target, name))
}

/// Lands in `Sparks/` shipped, with the minute, then publishes the site.
#[tauri::command]
pub fn publish_spark(
    app: AppHandle,
    text: String,
    connections: Option<Connections>,
) -> Result<SparkPublished, String> {
    let connections = connections.unwrap_or_default().normalized();
    let sparks = vault::sparks_dir_from_settings()?;
    let minute = Local::now().format("%Y-%m-%d %H:%M").to_string();
    let (target, name) = write_spark(&sparks, &text, &connections, &minute)?;
    let site_publish_skipped = ship_to_site(&app, true);
    Ok(SparkPublished {
        vault_path: target.to_string_lossy().to_string(),
        name,
        site_publish_skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        count_words, derive_title, resolve_vault_path, rewrite_and_copy_assets, riff_body,
        riff_frontmatter, sanitize_filename, spark_body, spark_frontmatter, write_spark,
    };
    use crate::commands::connections::{Connections, Quote};
    use crate::commands::frontmatter::parse;
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
    fn riff_frontmatter_matches_the_vault_template() {
        let c = Connections {
            conversations: vec!["Ember 2026".into()],
            topics: vec!["recovery".into(), "money".into()],
            links: vec!["[[Growth is death#^abc]]".into()],
            ship: true,
            quote: None,
        };
        let fm = riff_frontmatter(&c, "2026-09-14");
        assert_eq!(
            fm,
            "---\ntype: riff\nstatus:\n  - shipped\ndate: 2026-09-14\ntopics:\n  - recovery\n  - money\nriffs-on:\n  - \"[[Growth is death#^abc]]\"\nconversations:\n  - Ember 2026\n---\n\n"
        );
        let (parsed, _) = parse(&fm).unwrap();
        assert_eq!(parsed.scalar("type"), Some("riff"));
        assert_eq!(parsed.list("riffs-on"), vec!["[[Growth is death#^abc]]"]);

        let draft = riff_frontmatter(
            &Connections {
                ship: false,
                ..Default::default()
            },
            "2026-09-14",
        );
        assert_eq!(
            draft,
            "---\ntype: riff\nstatus:\n  - draft\ndate: 2026-09-14\ntopics: []\nriffs-on: []\nconversations: []\n---\n\n"
        );
    }

    #[test]
    fn spark_frontmatter_ships_with_the_minute() {
        let c = Connections {
            links: vec!["[[Phil Stutz]]".into()],
            ..Default::default()
        };
        let fm = spark_frontmatter(&c, "2026-09-14 13:48");
        assert_eq!(
            fm,
            "---\ntype: spark\nstatus:\n  - shipped\ndate: 2026-09-14 13:48\nsparked-by:\n  - \"[[Phil Stutz]]\"\ntopics: []\nconversations: []\n---\n\n"
        );
    }

    #[test]
    fn long_titles_cut_at_a_word_boundary() {
        let long = "You become who you are by having the conversations you're meant to have, and the breadcrumbs of resonance lead the way";
        let (title, _) = derive_title(long);
        assert!(title.chars().count() <= 80);
        // Cut exactly at a space in the original, never mid-word.
        assert!(long.starts_with(&format!("{} ", title)), "got: {title}");

        // The 80th character lands inside a word: back up to the last space.
        let mid_word = format!("{} {}", "a".repeat(70), "b".repeat(20));
        assert_eq!(derive_title(&mid_word).0, "a".repeat(70));

        // A title that fits is untouched.
        assert_eq!(derive_title("Short and sweet").0, "Short and sweet");
    }

    #[test]
    fn h1_inline_markers_are_stripped() {
        let (title, body) = derive_title("# **Bold** and *loose*\n\nBody.");
        assert_eq!(title, "Bold and loose");
        assert_eq!(body, "Body.");
    }

    #[test]
    fn word_count_ignores_markers() {
        assert_eq!(count_words("- one\n- two\n\n***\n\n**three**"), 3);
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
    #[test]
    fn missing_image_aborts_before_copying_any_assets() {
        let drafts = temp_dir("missing-source");
        let vault = temp_dir("missing-vault");
        fs::create_dir_all(drafts.join(".assets")).unwrap();
        fs::write(drafts.join(".assets/valid.png"), b"image").unwrap();
        assert!(rewrite_and_copy_assets(
            "![](.assets/valid.png) ![](.assets/missing.png)",
            &drafts,
            &vault
        )
        .is_err());
        assert!(!vault.join("assets/valid.png").exists());
        let _ = fs::remove_dir_all(drafts);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn same_named_vault_images_are_preserved() {
        let drafts = temp_dir("collision-source");
        let vault = temp_dir("collision-vault");
        fs::create_dir_all(drafts.join(".assets")).unwrap();
        fs::create_dir_all(vault.join("assets")).unwrap();
        fs::write(drafts.join(".assets/pic.png"), b"new image").unwrap();
        fs::write(vault.join("assets/pic.png"), b"existing image").unwrap();
        let (body, _) = rewrite_and_copy_assets("![](.assets/pic.png)", &drafts, &vault).unwrap();
        assert_eq!(body, "![](assets/pic-2.png)");
        assert_eq!(
            fs::read(vault.join("assets/pic.png")).unwrap(),
            b"existing image"
        );
        let _ = fs::remove_dir_all(drafts);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn asset_path_cannot_escape_the_draft_image_folder() {
        let drafts = temp_dir("traversal-source");
        let vault = temp_dir("traversal-vault");
        fs::create_dir_all(drafts.join(".assets")).unwrap();
        fs::write(drafts.join("private.txt"), b"private").unwrap();
        assert!(rewrite_and_copy_assets("![](.assets/../private.txt)", &drafts, &vault).is_err());
        assert!(!vault.join("assets/private.txt").exists());
        let _ = fs::remove_dir_all(drafts);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn a_spark_is_named_by_its_first_line_and_keeps_its_whole_text() {
        let sparks = temp_dir("sparks");
        let c = Connections {
            conversations: vec!["Befriending technology".into()],
            topics: vec!["intelligence".into()],
            links: vec![],
            ship: true,
            quote: None,
        };
        let text = "The world feels so fucked because we've spent two centuries conceptualizing humans as machines.\n\nBut the future is one where humans are free to become more human.";
        let (path, name) = write_spark(&sparks, text, &c, "2026-09-14 13:48").unwrap();
        assert_eq!(
            name,
            "The world feels so fucked because we've spent two centuries conceptualizing"
        );
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            format!("{}.md", name)
        );
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.starts_with("---\ntype: spark\nstatus:\n  - shipped\ndate: 2026-09-14 13:48\nsparked-by: []\ntopics:\n  - intelligence\nconversations:\n  - Befriending technology\n---\n\nThe world feels"), "got: {written}");
        assert!(written.ends_with("more human.\n"));

        // Same first line again → Obsidian-style " 2" suffix, nothing overwritten.
        let (second, _) = write_spark(&sparks, text, &c, "2026-09-14 13:49").unwrap();
        assert!(second.to_string_lossy().ends_with(" 2.md"));
        assert!(write_spark(&sparks, "\n\n", &c, "2026-09-14 13:50").is_err());
        let _ = fs::remove_dir_all(&sparks);
    }

    // ── a passage handed over by another app (Trove) ──

    fn buber() -> Quote {
        Quote {
            text: "All real living is meeting.\n\nSecond paragraph of the passage.".into(),
            title: "I and Thou".into(),
            author: "Martin Buber".into(),
            page: "11".into(),
            link: "I and Thou#^3fa9c2".into(),
        }
    }

    const BUBER_BLOCK: &str = "> All real living is meeting.\n>\n> Second paragraph of the passage.\n>\n> — Martin Buber, [[I and Thou#^3fa9c2|I and Thou]], p. 11";

    #[test]
    fn a_spark_puts_the_quote_under_his_words() {
        assert_eq!(
            spark_body("Meeting is the whole thing.\n", Some(&buber())),
            format!("Meeting is the whole thing.\n\n{}", BUBER_BLOCK)
        );
        // No quote: exactly what it was before.
        assert_eq!(spark_body(" Just a thought.\n", None), "Just a thought.");
    }

    #[test]
    fn a_riff_puts_the_quote_above_his_words() {
        assert_eq!(
            riff_body(
                "\nMeeting is the whole thing.\n\nMore of it.\n",
                Some(&buber())
            ),
            format!(
                "{}\n\nMeeting is the whole thing.\n\nMore of it.\n",
                BUBER_BLOCK
            )
        );
        // No quote: exactly what it was before.
        assert_eq!(riff_body("\nJust a thought.\n", None), "Just a thought.\n");
    }

    #[test]
    fn a_riff_with_a_quote_is_still_named_by_his_words() {
        // The same steps `publish_riff` takes: the title comes from the
        // draft, and only then does the quote join the body.
        let (title, body) = derive_title("# On meeting\n\nMeeting is the whole thing.");
        assert_eq!(title, "On meeting");
        assert_eq!(
            riff_body(&body, Some(&buber())),
            format!("{}\n\nMeeting is the whole thing.", BUBER_BLOCK)
        );

        let (title, _) = derive_title("Meeting is the whole thing.\n\nMore of it.");
        assert_eq!(title, "Meeting is the whole thing.");
    }

    #[test]
    fn a_spark_with_a_quote_is_named_by_his_words_and_links_the_source() {
        let sparks = temp_dir("sparks-quote");
        // What the spark window sends: the quote, and its link among the links.
        let c = Connections {
            links: vec!["[[I and Thou#^3fa9c2]]".into()],
            quote: Some(buber()),
            ..Default::default()
        }
        .normalized();
        let (path, name) = write_spark(
            &sparks,
            "Meeting is the whole thing.",
            &c,
            "2026-11-15 09:30",
        )
        .unwrap();

        assert_eq!(name, "Meeting is the whole thing.");
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            "Meeting is the whole thing.md"
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!(
                "---\ntype: spark\nstatus:\n  - shipped\ndate: 2026-11-15 09:30\nsparked-by:\n  - \"[[I and Thou#^3fa9c2]]\"\ntopics: []\nconversations: []\n---\n\nMeeting is the whole thing.\n\n{}\n",
                BUBER_BLOCK
            )
        );
        let _ = fs::remove_dir_all(&sparks);
    }

    #[test]
    fn a_quote_without_a_link_adds_nothing_to_the_front_matter() {
        let sparks = temp_dir("sparks-no-link");
        let c = Connections {
            quote: Some(Quote {
                link: String::new(),
                ..buber()
            }),
            ..Default::default()
        }
        .normalized();
        let (path, _) = write_spark(&sparks, "Meeting.", &c, "2026-11-15 09:30").unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\nsparked-by: []\n"), "got: {written}");
        assert!(
            written.ends_with("> — Martin Buber, I and Thou, p. 11\n"),
            "got: {written}"
        );
        let _ = fs::remove_dir_all(&sparks);
    }

    #[test]
    fn a_quote_alone_is_not_a_spark() {
        let sparks = temp_dir("sparks-quote-only");
        let c = Connections {
            quote: Some(buber()),
            ..Default::default()
        }
        .normalized();
        assert!(write_spark(&sparks, "", &c, "2026-11-15 09:30").is_err());
        assert!(write_spark(&sparks, "\n  \n", &c, "2026-11-15 09:30").is_err());
        // Nothing was written.
        assert_eq!(fs::read_dir(&sparks).map(|d| d.count()).unwrap_or(0), 0);
        let _ = fs::remove_dir_all(&sparks);
    }
}
