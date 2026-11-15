/// Vault-wide [[wiki-link]] targets: every markdown note in the Obsidian
/// vault, searchable by name so a riff can link to people, ideas, and older
/// notes — and the links are live the moment it publishes.
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use super::frontmatter;
use super::settings;

const MAX_RESULTS: usize = 30;
const MAX_RECENTS: usize = 5;
const MAX_DEPTH: usize = 8;
const CACHE_TTL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
pub struct VaultLink {
    /// The note's name (file stem) — what goes between the [[brackets]].
    pub name: String,
    pub path: String,
    /// Last-modified time in epoch seconds; recency ranking for a bare [[.
    pub modified: u64,
}

/// The configured vault folder is where riffs *publish* — often a subfolder
/// of the actual Obsidian vault (Rob's: `The Conversation/Riffs`). Links
/// should complete against the whole vault, so walk up looking for the
/// `.obsidian` marker; if none is found, the configured folder stands.
fn find_vault_root(publish_dir: &Path) -> PathBuf {
    let mut candidate = publish_dir;
    for _ in 0..4 {
        if candidate.join(".obsidian").is_dir() {
            return candidate.to_path_buf();
        }
        match candidate.parent() {
            Some(parent) => candidate = parent,
            None => break,
        }
    }
    publish_dir.to_path_buf()
}

/// The Obsidian vault the configured riffs folder lives in.
pub fn vault_root_from_settings() -> Result<PathBuf, String> {
    let settings = settings::load_settings_from_file()?;
    let vault_dir = settings
        .vault_dir
        .filter(|v| !v.trim().is_empty())
        .ok_or("No vault folder configured")?;
    let publish_dir = PathBuf::from(&vault_dir);
    if !publish_dir.is_dir() {
        return Err(format!("Vault folder does not exist: {}", vault_dir));
    }
    Ok(find_vault_root(&publish_dir))
}

/// Where sparks land: the configured folder, else `<vault root>/Sparks`.
pub fn sparks_dir_from_settings() -> Result<PathBuf, String> {
    let settings = settings::load_settings_from_file()?;
    if let Some(dir) = settings.sparks_dir.filter(|d| !d.trim().is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(vault_root_from_settings()?.join("Sparks"))
}

/// One vault scan, cached briefly — autocomplete fires per keystroke and the
/// vault doesn't change that fast.
struct ScanCache {
    vault_dir: String,
    scanned_at: Instant,
    links: Vec<VaultLink>,
}

static SCAN_CACHE: Mutex<Option<ScanCache>> = Mutex::new(None);

fn collect_md_notes(dir: &Path, out: &mut Vec<VaultLink>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip dotted dirs/files (.obsidian, .trash, …) and published assets.
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if name.eq_ignore_ascii_case("assets") {
                continue;
            }
            collect_md_notes(&path, out, depth + 1);
        } else if let Some(stem) = name.strip_suffix(".md") {
            if stem.is_empty() {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(VaultLink {
                name: stem.to_string(),
                path: path.to_string_lossy().to_string(),
                modified,
            });
        }
    }
}

fn scan_vault(vault_dir: &str) -> Vec<VaultLink> {
    let mut cache = SCAN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = cache.as_ref() {
        if c.vault_dir == vault_dir && c.scanned_at.elapsed() < CACHE_TTL {
            return c.links.clone();
        }
    }

    let mut links = Vec::new();
    collect_md_notes(Path::new(vault_dir), &mut links, 0);
    *cache = Some(ScanCache {
        vault_dir: vault_dir.to_string(),
        scanned_at: Instant::now(),
        links: links.clone(),
    });
    links
}

/// Rank matches: name-prefix hits first, then substring hits, both
/// alphabetical; duplicate names (same note name in two folders) collapse to
/// the first seen, since [[links]] resolve by name anyway. A bare `[[`
/// (empty query) instead offers the most recently edited notes — the things
/// the writer is most likely mid-conversation with.
fn rank(links: Vec<VaultLink>, query: &str) -> Vec<VaultLink> {
    let mut seen: HashSet<String> = HashSet::new();

    if query.is_empty() {
        let mut recents: Vec<VaultLink> = links
            .into_iter()
            .filter(|l| seen.insert(l.name.to_lowercase()))
            .collect();
        recents.sort_by_key(|note| std::cmp::Reverse(note.modified));
        recents.truncate(MAX_RECENTS);
        return recents;
    }

    let q = query.to_lowercase();
    let mut prefix: Vec<VaultLink> = Vec::new();
    let mut contains: Vec<VaultLink> = Vec::new();

    for link in links {
        let lower = link.name.to_lowercase();
        if !seen.insert(lower.clone()) {
            continue;
        }
        if lower.starts_with(&q) {
            prefix.push(link);
        } else if lower.contains(&q) {
            contains.push(link);
        }
    }

    let by_name = |a: &VaultLink, b: &VaultLink| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    prefix.sort_by(by_name);
    contains.sort_by(by_name);
    prefix.extend(contains);
    prefix.truncate(MAX_RESULTS);
    prefix
}

/// Percent-encode for a URL query value; `/` survives so a nested note path
/// reads as a path.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// Obsidian's own URI for a note: `obsidian://open?vault=<name>&file=<path>`,
/// where the vault name is the folder that holds `.obsidian` and the path is
/// relative to it, without the extension.
fn obsidian_url(vault_root: &Path, note_path: &Path) -> Option<String> {
    let vault_name = vault_root.file_name()?.to_str()?;
    let rel = note_path.strip_prefix(vault_root).ok()?.to_str()?;
    let file = rel.strip_suffix(".md").unwrap_or(rel);
    Some(format!(
        "obsidian://open?vault={}&file={}",
        percent_encode(vault_name),
        percent_encode(file)
    ))
}

/// ⌘-click on a `[[vault note]]` in the room: hand it to Obsidian.
#[tauri::command]
pub fn open_vault_note(name: String) -> Result<bool, String> {
    let settings = settings::load_settings_from_file()?;
    let vault_dir = settings
        .vault_dir
        .filter(|v| !v.trim().is_empty())
        .ok_or("No vault folder configured")?;
    let publish_dir = Path::new(&vault_dir);
    if !publish_dir.is_dir() {
        return Err(format!("Vault folder does not exist: {}", vault_dir));
    }

    let root = find_vault_root(publish_dir);
    let wanted = name.trim().to_lowercase();
    let links = scan_vault(&root.to_string_lossy());
    let link = links
        .iter()
        .find(|l| l.name.to_lowercase() == wanted)
        .ok_or_else(|| format!("No note called “{}” in the vault", name.trim()))?;
    let url =
        obsidian_url(&root, Path::new(&link.path)).ok_or("Could not build the Obsidian link")?;
    // `open` hands the obsidian:// URL to whatever app claims the scheme.
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Could not open Obsidian: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub fn search_vault_links(query: String) -> Result<Vec<VaultLink>, String> {
    let settings = settings::load_settings_from_file()?;
    let Some(vault_dir) = settings.vault_dir.filter(|v| !v.trim().is_empty()) else {
        return Ok(vec![]); // no vault configured — nothing to link against
    };
    let publish_dir = Path::new(&vault_dir);
    if !publish_dir.is_dir() {
        return Ok(vec![]);
    }

    let root = find_vault_root(publish_dir);
    Ok(rank(scan_vault(&root.to_string_lossy()), &query))
}

// ---------- the vault's vocabulary: conversations and topics ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VocabEntry {
    pub name: String,
    /// How many typed notes carry it.
    pub count: usize,
    /// A conversation with a hub note (`type: conversation`) — the site
    /// renders those as real pages; the rest are loose tags.
    pub hub: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Vocabulary {
    pub conversations: Vec<VocabEntry>,
    pub topics: Vec<VocabEntry>,
}

/// Folders the site's sync ignores, so their properties don't count.
const VOCAB_SKIP_DIRS: &[&str] = &["Templates", "_templates", "Bases", "Journals", "Freewriting"];

fn collect_typed_notes(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if name.eq_ignore_ascii_case("assets") || VOCAB_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect_typed_notes(&path, out, depth + 1);
        } else if name.ends_with(".md") {
            out.push(path);
        }
    }
}

/// Canonical spelling wins: the hub note's own name for a conversation,
/// otherwise the most-used casing.
fn tally(root: &Path) -> Vocabulary {
    let mut notes = Vec::new();
    collect_typed_notes(root, &mut notes, 0);

    let mut hubs: BTreeMap<String, String> = BTreeMap::new(); // lower → hub name
    let mut conversations: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new(); // lower → spelling → count
    let mut topics: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();

    for path in notes {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some((fm, _)) = frontmatter::parse(&content) else {
            continue;
        };
        let Some(kind) = fm.scalar("type") else {
            continue;
        };
        if kind.eq_ignore_ascii_case("conversation") || kind.eq_ignore_ascii_case("series") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                hubs.insert(stem.to_lowercase(), stem.to_string());
            }
        }
        let mut convs = fm.list("conversations");
        if convs.is_empty() {
            convs = fm.list("series");
        }
        for c in convs {
            *conversations
                .entry(c.to_lowercase())
                .or_default()
                .entry(c)
                .or_default() += 1;
        }
        for t in fm.list("topics") {
            let t = t.trim_start_matches('#').to_string();
            *topics
                .entry(t.to_lowercase())
                .or_default()
                .entry(t)
                .or_default() += 1;
        }
    }

    let pick = |spellings: &BTreeMap<String, usize>| -> String {
        spellings
            .iter()
            .max_by_key(|(_, n)| **n)
            .map(|(s, _)| s.clone())
            .unwrap_or_default()
    };

    let mut conv_entries: Vec<VocabEntry> = Vec::new();
    for (lower, spellings) in &conversations {
        let count = spellings.values().sum();
        let name = hubs.get(lower).cloned().unwrap_or_else(|| pick(spellings));
        conv_entries.push(VocabEntry { name, count, hub: hubs.contains_key(lower) });
    }
    for (lower, name) in &hubs {
        if !conversations.contains_key(lower) {
            conv_entries.push(VocabEntry { name: name.clone(), count: 0, hub: true });
        }
    }
    // Hubs first, then by use, then by name.
    conv_entries.sort_by(|a, b| {
        b.hub
            .cmp(&a.hub)
            .then(b.count.cmp(&a.count))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let mut topic_entries: Vec<VocabEntry> = topics
        .values()
        .map(|spellings| VocabEntry { name: pick(spellings), count: spellings.values().sum(), hub: false })
        .collect();
    topic_entries.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));

    Vocabulary { conversations: conv_entries, topics: topic_entries }
}

struct VocabCache {
    root: PathBuf,
    scanned_at: Instant,
    vocabulary: Vocabulary,
}

static VOCAB_CACHE: Mutex<Option<VocabCache>> = Mutex::new(None);

/// Every conversation and topic in use across the vault, for the pickers.
#[tauri::command]
pub fn vault_vocabulary() -> Result<Vocabulary, String> {
    let Ok(root) = vault_root_from_settings() else {
        return Ok(Vocabulary::default());
    };
    let mut cache = VOCAB_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = cache.as_ref() {
        if c.root == root && c.scanned_at.elapsed() < CACHE_TTL {
            return Ok(c.vocabulary.clone());
        }
    }
    let vocabulary = tally(&root);
    *cache = Some(VocabCache { root, scanned_at: Instant::now(), vocabulary: vocabulary.clone() });
    Ok(vocabulary)
}

#[cfg(test)]
mod tests {
    use super::{collect_md_notes, find_vault_root, obsidian_url, percent_encode, rank, tally, VaultLink};
    use std::path::Path;

    #[test]
    fn obsidian_urls_name_the_vault_and_the_relative_note_path() {
        let root = Path::new("/Users/rob/Local Shit/The Conversation");
        let note =
            Path::new("/Users/rob/Local Shit/The Conversation/Riffs/Stutz, my new teacher.md");
        assert_eq!(
            obsidian_url(root, note).as_deref(),
            Some(
                "obsidian://open?vault=The%20Conversation&file=Riffs/Stutz%2C%20my%20new%20teacher"
            )
        );
        // A note outside the vault has no URL.
        assert!(obsidian_url(root, Path::new("/elsewhere/Note.md")).is_none());
    }

    #[test]
    fn percent_encoding_keeps_slashes_and_unreserved_characters() {
        assert_eq!(percent_encode("a-b_c.d~e/f"), "a-b_c.d~e/f");
        assert_eq!(percent_encode("Kara Smith & co"), "Kara%20Smith%20%26%20co");
    }
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("riff-vault-{}", unique));
        fs::create_dir_all(&dir).expect("create temp vault");
        dir
    }

    fn link(name: &str) -> VaultLink {
        link_at(name, 0)
    }

    fn link_at(name: &str, modified: u64) -> VaultLink {
        VaultLink {
            name: name.to_string(),
            path: format!("/vault/{}.md", name),
            modified,
        }
    }

    #[test]
    fn vault_root_is_found_by_walking_up_to_the_obsidian_marker() {
        let root = temp_vault();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::create_dir_all(root.join("Riffs")).unwrap();

        assert_eq!(find_vault_root(&root.join("Riffs")), root);
        // No marker anywhere: the publish folder itself stands.
        let bare = temp_vault();
        assert_eq!(find_vault_root(&bare), bare);

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&bare);
    }

    #[test]
    fn bare_query_offers_the_five_most_recent_notes() {
        let links = vec![
            link_at("Oldest", 10),
            link_at("Newer", 500),
            link_at("Newest", 900),
            link_at("Mid", 300),
            link_at("Older", 100),
            link_at("Ancient", 1),
        ];
        let recents = rank(links, "");
        let names: Vec<String> = recents.into_iter().map(|l| l.name).collect();
        assert_eq!(names, vec!["Newest", "Newer", "Mid", "Older", "Oldest"]);
    }

    #[test]
    fn scans_nested_notes_but_skips_dotted_and_asset_dirs() {
        let vault = temp_vault();
        fs::write(vault.join("Kara Smith.md"), "").unwrap();
        fs::create_dir_all(vault.join("People")).unwrap();
        fs::write(vault.join("People/Amjad.md"), "").unwrap();
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        fs::write(vault.join(".obsidian/hidden.md"), "").unwrap();
        fs::create_dir_all(vault.join("assets")).unwrap();
        fs::write(vault.join("assets/pic.md"), "").unwrap();
        fs::write(vault.join("not-a-note.txt"), "").unwrap();

        let mut links = Vec::new();
        collect_md_notes(&vault, &mut links, 0);
        let mut names: Vec<String> = links.into_iter().map(|l| l.name).collect();
        names.sort();

        assert_eq!(names, vec!["Amjad".to_string(), "Kara Smith".to_string()]);
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn prefix_matches_outrank_substring_matches() {
        let links = vec![
            link("Weekly Kara sync"),
            link("Kara Smith"),
            link("Karaoke"),
        ];
        let ranked = rank(links, "kara");
        let names: Vec<String> = ranked.into_iter().map(|l| l.name).collect();
        assert_eq!(names, vec!["Kara Smith", "Karaoke", "Weekly Kara sync"]);
    }

    #[test]
    fn duplicate_note_names_collapse() {
        let links = vec![link("Kara"), link("Kara")];
        assert_eq!(rank(links, "ka").len(), 1);
    }

    #[test]
    fn vocabulary_counts_typed_notes_and_prefers_hub_spelling() {
        let vault = temp_vault();
        fs::create_dir_all(vault.join("Conversations")).unwrap();
        fs::write(vault.join("Conversations/Befriending shame.md"), "---\ntype: conversation\nstatus:\n  - draft\n---\n").unwrap();
        fs::write(vault.join("a.md"), "---\ntype: riff\ntopics:\n  - recovery\n  - Money\nconversations:\n  - befriending shame\n---\n").unwrap();
        fs::write(vault.join("b.md"), "---\ntype: spark\ntopics: [recovery]\nconversations:\n  - Ember 2026\n---\n").unwrap();
        // Untyped notes and template folders don't count.
        fs::write(vault.join("c.md"), "---\ntopics:\n  - ignored\nconversations:\n  - ignored\n---\n").unwrap();
        fs::create_dir_all(vault.join("Templates")).unwrap();
        fs::write(vault.join("Templates/Spark.md"), "---\ntype: spark\ntopics:\n  - templated\n---\n").unwrap();

        let v = tally(&vault);
        let convs: Vec<(String, usize, bool)> = v.conversations.iter().map(|e| (e.name.clone(), e.count, e.hub)).collect();
        assert_eq!(convs, vec![("Befriending shame".to_string(), 1, true), ("Ember 2026".to_string(), 1, false)]);
        let topics: Vec<(String, usize)> = v.topics.iter().map(|e| (e.name.clone(), e.count)).collect();
        assert_eq!(topics, vec![("recovery".to_string(), 2), ("Money".to_string(), 1)]);
        let _ = fs::remove_dir_all(&vault);
    }
}
