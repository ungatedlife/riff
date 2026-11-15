/// What a piece connects to: the conversations it belongs to, its topics,
/// and the notes it builds on (`riffs-on` for a riff, `sparked-by` for a
/// spark). For an unfinished riff these live in a sidecar keyed by the
/// draft's path — the draft file itself stays plain Markdown, so nothing
/// ever shows in the room that isn't the writing.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

fn default_ship() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Connections {
    #[serde(default)]
    pub conversations: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    /// `[[wikilinks]]`, brackets included, the way the vault stores them.
    #[serde(default)]
    pub links: Vec<String>,
    /// Ship (status: shipped, live on the next publish) or keep as a vault
    /// draft. Sparks always ship; riffs choose.
    #[serde(default = "default_ship")]
    pub ship: bool,
}

impl Default for Connections {
    fn default() -> Self {
        Self {
            conversations: Vec::new(),
            topics: Vec::new(),
            links: Vec::new(),
            ship: true,
        }
    }
}

impl Connections {
    /// Trimmed, de-duplicated (case-insensitively), empties dropped.
    pub fn normalized(&self) -> Connections {
        fn clean(items: &[String]) -> Vec<String> {
            let mut seen = std::collections::HashSet::new();
            items
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && seen.insert(s.to_lowercase()))
                .collect()
        }
        let topics: Vec<String> = self
            .topics
            .iter()
            .map(|t| t.trim().trim_start_matches('#').to_string())
            .collect();
        let links: Vec<String> = self
            .links
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|l| {
                let inner = l.trim_start_matches("[[").trim_end_matches("]]").trim();
                format!("[[{}]]", inner)
            })
            .collect();
        Connections {
            conversations: clean(&self.conversations),
            topics: clean(&topics),
            links: clean(&links),
            ship: self.ship,
        }
    }
}

fn sidecar_path() -> Result<PathBuf, String> {
    Ok(super::settings::get_settings_path()?.with_file_name("connections.json"))
}

fn load_all() -> Result<HashMap<String, Connections>, String> {
    let path = sidecar_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn write_all(all: &HashMap<String, Connections>) -> Result<(), String> {
    let path = sidecar_path()?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string(all).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_connections(id: String) -> Result<Option<Connections>, String> {
    Ok(load_all()?.get(&id).cloned())
}

#[tauri::command]
pub fn save_connections(id: String, connections: Connections) -> Result<(), String> {
    let mut all = load_all()?;
    all.insert(id, connections);
    write_all(&all)
}

#[tauri::command]
pub fn remove_connections(id: String) -> Result<(), String> {
    let mut all = load_all()?;
    if all.remove(&id).is_some() {
        write_all(&all)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Connections;

    #[test]
    fn normalization_trims_dedupes_and_brackets_links() {
        let c = Connections {
            conversations: vec![" Ember 2026 ".into(), "ember 2026".into(), "".into()],
            topics: vec!["#recovery".into(), "recovery".into(), "money".into()],
            links: vec!["Growth is death".into(), "[[Growth is death]]".into(), "[[A#^b]]".into()],
            ship: false,
        }
        .normalized();
        assert_eq!(c.conversations, vec!["Ember 2026"]);
        assert_eq!(c.topics, vec!["recovery", "money"]);
        assert_eq!(c.links, vec!["[[Growth is death]]", "[[A#^b]]"]);
        assert!(!c.ship);
    }

    #[test]
    fn missing_fields_default_to_shipping() {
        let c: Connections = serde_json::from_str("{}").unwrap();
        assert!(c.ship);
        assert!(c.topics.is_empty());
    }
}
