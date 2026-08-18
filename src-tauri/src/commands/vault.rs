/// Vault-wide [[wiki-link]] targets: every markdown note in the Obsidian
/// vault, searchable by name so a riff can link to people, ideas, and older
/// notes — and the links are live the moment it publishes.
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
        recents.sort_by(|a, b| b.modified.cmp(&a.modified));
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

#[cfg(test)]
mod tests {
    use super::{collect_md_notes, find_vault_root, rank, VaultLink};
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
}
