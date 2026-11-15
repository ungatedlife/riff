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

/// A passage another app (Trove, the reading app) handed over for this
/// piece to respond to. It rides with the piece's connections and is
/// written into the note as a blockquote when the piece leaves Riff. It is
/// never part of the text being edited.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Quote {
    /// The passage itself. Paragraphs are separated by a blank line.
    #[serde(default)]
    pub text: String,
    /// The book's title.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author: String,
    /// The printed page label ("11", "xiv").
    #[serde(default)]
    pub page: String,
    /// The vault note and block the passage lives at, without the `[[ ]]`
    /// ("I and Thou#^3fa9c2"). Empty when there is none.
    #[serde(default)]
    pub link: String,
}

impl Quote {
    /// Everything trimmed, any `[[ ]]` taken off the link. None when there
    /// is no passage left to quote.
    pub fn normalized(&self) -> Option<Quote> {
        let text = self.text.trim();
        if text.is_empty() {
            return None;
        }
        let link = self.link.trim();
        let link = link.trim_start_matches("[[").trim_end_matches("]]").trim();
        Some(Quote {
            text: text.to_string(),
            title: self.title.trim().to_string(),
            author: self.author.trim().to_string(),
            page: self.page.trim().to_string(),
            link: link.to_string(),
        })
    }

    /// "Martin Buber, [[I and Thou#^3fa9c2|I and Thou]], p. 11", leaving
    /// out whatever is missing. With no link the title is plain text.
    fn attribution(&self) -> String {
        let source = match (self.title.is_empty(), self.link.is_empty()) {
            (false, false) => format!("[[{}|{}]]", self.link, self.title),
            (false, true) => self.title.clone(),
            (true, false) => format!("[[{}]]", self.link),
            (true, true) => String::new(),
        };
        let page = if self.page.is_empty() {
            String::new()
        } else {
            format!("p. {}", self.page)
        };
        [self.author.clone(), source, page]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The passage as a Markdown blockquote: every line starts with `> `,
    /// paragraphs are separated by a bare `>`, and the attribution closes
    /// it on a line of its own. Expects a normalized quote.
    pub fn block(&self) -> String {
        let mut lines: Vec<String> = Vec::new();
        // True once a blank line has been passed: the next line of text
        // starts a new paragraph.
        let mut new_paragraph = false;
        for line in self.text.lines() {
            let line = line.trim();
            if line.is_empty() {
                new_paragraph = true;
                continue;
            }
            if new_paragraph && !lines.is_empty() {
                lines.push(">".to_string());
            }
            new_paragraph = false;
            lines.push(format!("> {}", line));
        }
        let attribution = self.attribution();
        if !attribution.is_empty() {
            if !lines.is_empty() {
                lines.push(">".to_string());
            }
            lines.push(format!("> — {}", attribution));
        }
        lines.join("\n")
    }
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
    /// The passage this piece responds to, if another app handed one over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<Quote>,
}

impl Default for Connections {
    fn default() -> Self {
        Self {
            conversations: Vec::new(),
            topics: Vec::new(),
            links: Vec::new(),
            ship: true,
            quote: None,
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
            quote: self.quote.as_ref().and_then(Quote::normalized),
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
    use super::{Connections, Quote};

    fn buber() -> Quote {
        Quote {
            text: "All real living is meeting.\n\nSecond paragraph of the passage.".into(),
            title: "I and Thou".into(),
            author: "Martin Buber".into(),
            page: "11".into(),
            link: "I and Thou#^3fa9c2".into(),
        }
    }

    #[test]
    fn normalization_trims_dedupes_and_brackets_links() {
        let c = Connections {
            conversations: vec![" Ember 2026 ".into(), "ember 2026".into(), "".into()],
            topics: vec!["#recovery".into(), "recovery".into(), "money".into()],
            links: vec![
                "Growth is death".into(),
                "[[Growth is death]]".into(),
                "[[A#^b]]".into(),
            ],
            ship: false,
            quote: None,
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

    #[test]
    fn a_quote_block_carries_every_paragraph_and_its_attribution() {
        assert_eq!(
            buber().block(),
            "> All real living is meeting.\n>\n> Second paragraph of the passage.\n>\n> — Martin Buber, [[I and Thou#^3fa9c2|I and Thou]], p. 11"
        );
    }

    #[test]
    fn a_line_break_inside_a_paragraph_stays_inside_it() {
        let quote = Quote {
            text: "First line\nsecond line\r\n\r\n\n  Next paragraph.  ".into(),
            ..buber()
        }
        .normalized()
        .unwrap();
        assert_eq!(
            quote.block(),
            "> First line\n> second line\n>\n> Next paragraph.\n>\n> — Martin Buber, [[I and Thou#^3fa9c2|I and Thou]], p. 11"
        );
    }

    #[test]
    fn the_attribution_leaves_out_what_is_missing() {
        let line = |q: Quote| q.block().lines().last().unwrap().to_string();
        assert_eq!(
            line(buber()),
            "> — Martin Buber, [[I and Thou#^3fa9c2|I and Thou]], p. 11"
        );
        // No author: start with the title.
        assert_eq!(
            line(Quote {
                author: String::new(),
                ..buber()
            }),
            "> — [[I and Thou#^3fa9c2|I and Thou]], p. 11"
        );
        // No link: the title as plain text.
        assert_eq!(
            line(Quote {
                link: String::new(),
                ..buber()
            }),
            "> — Martin Buber, I and Thou, p. 11"
        );
        // No page: no ", p. …".
        assert_eq!(
            line(Quote {
                page: String::new(),
                ..buber()
            }),
            "> — Martin Buber, [[I and Thou#^3fa9c2|I and Thou]]"
        );
    }

    #[test]
    fn normalizing_trims_a_quote_and_drops_an_empty_one() {
        let c = Connections {
            quote: Some(Quote {
                text: "  All real living is meeting.\n".into(),
                title: " I and Thou ".into(),
                author: " Martin Buber".into(),
                page: " 11 ".into(),
                link: "[[I and Thou#^3fa9c2]]".into(),
            }),
            ..Default::default()
        }
        .normalized();
        let quote = c.quote.unwrap();
        assert_eq!(quote.text, "All real living is meeting.");
        assert_eq!(quote.title, "I and Thou");
        assert_eq!(quote.author, "Martin Buber");
        assert_eq!(quote.page, "11");
        assert_eq!(quote.link, "I and Thou#^3fa9c2");

        let empty = Connections {
            quote: Some(Quote {
                text: " \n ".into(),
                ..buber()
            }),
            ..Default::default()
        }
        .normalized();
        assert!(empty.quote.is_none());
    }

    #[test]
    fn a_quote_rides_in_the_sidecar_and_old_entries_still_load() {
        // Entries saved before quotes existed have no `quote` key.
        let old: Connections =
            serde_json::from_str(r#"{"topics":["money"],"ship":false}"#).unwrap();
        assert!(old.quote.is_none());
        // No quote, no key: the sidecar stays as it was.
        assert!(!serde_json::to_string(&old).unwrap().contains("quote"));

        let with = Connections {
            quote: Some(buber()),
            ..Default::default()
        };
        let json = serde_json::to_string(&with).unwrap();
        let back: Connections = serde_json::from_str(&json).unwrap();
        assert_eq!(back, with);
    }
}
