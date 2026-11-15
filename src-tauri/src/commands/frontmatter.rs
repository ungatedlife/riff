/// The vault's front matter, read and written the way Obsidian and the site's
/// sync expect it: a small YAML subset — scalars, block lists, inline lists,
/// single- or double-quoted strings. Nothing fancier lives in Rob's notes.
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Scalar(String),
    List(Vec<String>),
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Frontmatter {
    /// Ordered, so a note round-trips in the order it was written.
    pub fields: Vec<(String, Value)>,
}

impl Frontmatter {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v)
    }

    pub fn scalar(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Value::Scalar(s) => Some(s.as_str()),
            Value::List(items) => items.first().map(String::as_str),
        }
    }

    /// A list property; a lone scalar counts as a one-item list (Obsidian
    /// happily writes `conversations: Ember` for a single value).
    pub fn list(&self, key: &str) -> Vec<String> {
        match self.get(key) {
            Some(Value::List(items)) => items.clone(),
            Some(Value::Scalar(s)) if !s.trim().is_empty() => vec![s.clone()],
            _ => Vec::new(),
        }
    }
}

fn unquote(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 {
        let bytes = s.as_bytes();
        if bytes[0] == b'"' && bytes[s.len() - 1] == b'"' {
            return s[1..s.len() - 1]
                .replace("\\\"", "\"")
                .replace("\\\\", "\\");
        }
        if bytes[0] == b'\'' && bytes[s.len() - 1] == b'\'' {
            return s[1..s.len() - 1].replace("''", "'");
        }
    }
    s.to_string()
}

fn parse_inline_list(inner: &str) -> Vec<String> {
    // Split on commas outside quotes.
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in inner.chars() {
        match quote {
            Some(q) => {
                current.push(c);
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' => {
                    current.push(c);
                    quote = Some(c);
                }
                ',' => {
                    items.push(unquote(&current));
                    current.clear();
                }
                _ => current.push(c),
            },
        }
    }
    if !current.trim().is_empty() {
        items.push(unquote(&current));
    }
    items.into_iter().filter(|s| !s.is_empty()).collect()
}

/// Split a note into its front matter and body. Returns `None` when the note
/// has no front matter block at all.
pub fn parse(content: &str) -> Option<(Frontmatter, &str)> {
    let rest = content.strip_prefix("---")?;
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))?;
    // Find the closing fence on its own line.
    let mut offset = 0;
    let mut end = None;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            end = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let (block_end, body_start) = end?;
    let block = &rest[..block_end];
    let body = &rest[body_start..];

    let mut fm = Frontmatter::default();
    let mut current_list: Option<usize> = None;
    for raw in block.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if let Some(item) = line.trim_start().strip_prefix("- ") {
            if line.starts_with(' ') || line.starts_with('\t') {
                if let Some(idx) = current_list {
                    if let Value::List(items) = &mut fm.fields[idx].1 {
                        let value = unquote(item);
                        if !value.is_empty() {
                            items.push(value);
                        }
                    }
                    continue;
                }
            }
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            // Nested structure we don't model (e.g. the sync's handwritten
            // block); skip its lines.
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let value = value.trim();
        let parsed = if value.is_empty() {
            Value::List(Vec::new())
        } else if value.starts_with('[') && value.ends_with(']') {
            Value::List(parse_inline_list(&value[1..value.len() - 1]))
        } else {
            Value::Scalar(unquote(value))
        };
        current_list = matches!(parsed, Value::List(_)).then_some(fm.fields.len());
        fm.fields.push((key, parsed));
    }
    Some((fm, body))
}

/// Quote a value only when YAML would otherwise misread it: wikilinks,
/// colons, hashes, leading punctuation, or a value that looks like another
/// type. Obsidian writes exactly this way.
pub fn quote(value: &str) -> String {
    let needs = value.is_empty()
        || value.contains("[[")
        || value.contains('"')
        || value.contains(": ")
        || value.ends_with(':')
        || value.contains(" #")
        || value.starts_with([
            '#', '[', ']', '{', '}', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`', '-', '?',
        ])
        || value.trim() != value
        || matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "false" | "null" | "yes" | "no" | "~"
        )
        || value.parse::<f64>().is_ok();
    if needs {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

/// `key: []` for nothing, otherwise a block list — the shape the vault's
/// templates and the site's sync both write.
pub fn yaml_list(key: &str, items: &[String]) -> String {
    let mut out = String::new();
    if items.is_empty() {
        let _ = writeln!(out, "{}: []", key);
        return out;
    }
    let _ = writeln!(out, "{}:", key);
    for item in items {
        let _ = writeln!(out, "  - {}", quote(item));
    }
    out
}

pub fn yaml_scalar(key: &str, value: &str) -> String {
    format!("{}: {}\n", key, quote(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_vaults_spark_shape() {
        let note = "---\nid: s-002\ntype: spark\nstatus:\n  - shipped\ndate: 2026-09-14 19:00\nsparked-by: []\ntopics:\n  - perfectionism\n  - transformation\nconversations:\n  - Befriending shame\n---\n\nFor a long time…\n";
        let (fm, body) = parse(note).expect("front matter");
        assert_eq!(fm.scalar("type"), Some("spark"));
        assert_eq!(fm.list("status"), vec!["shipped"]);
        assert_eq!(fm.scalar("date"), Some("2026-09-14 19:00"));
        assert!(fm.list("sparked-by").is_empty());
        assert_eq!(fm.list("topics"), vec!["perfectionism", "transformation"]);
        assert_eq!(fm.list("conversations"), vec!["Befriending shame"]);
        assert_eq!(body, "\nFor a long time…\n");
    }

    #[test]
    fn quoted_wikilinks_and_inline_lists_unwrap() {
        let note = "---\nriffs-on:\n  - '[[I riff, therefore I am#^ec2139]]'\n  - \"[[Tiny habits]]\"\ntopics: [a, \"b, c\"]\nconversations: Ember 2026\n---\nbody";
        let (fm, _) = parse(note).unwrap();
        assert_eq!(
            fm.list("riffs-on"),
            vec!["[[I riff, therefore I am#^ec2139]]", "[[Tiny habits]]"]
        );
        assert_eq!(fm.list("topics"), vec!["a", "b, c"]);
        assert_eq!(fm.list("conversations"), vec!["Ember 2026"]);
    }

    #[test]
    fn notes_without_front_matter_return_none() {
        assert!(parse("Just words\n---\nnot front matter").is_none());
        assert!(parse("---\nnever closed\n").is_none());
    }

    #[test]
    fn nested_structures_are_skipped_without_breaking_the_rest() {
        let note = "---\ntype: riff\nhandwritten:\n  pdf: r-015.pdf\n  pages:\n    - src: r-015/p1.webp\nstatus:\n  - shipped\n---\n";
        let (fm, _) = parse(note).unwrap();
        assert_eq!(fm.scalar("type"), Some("riff"));
        assert_eq!(fm.list("status"), vec!["shipped"]);
    }

    #[test]
    fn writes_lists_the_way_obsidian_does() {
        assert_eq!(yaml_list("topics", &[]), "topics: []\n");
        assert_eq!(
            yaml_list(
                "riffs-on",
                &["[[Growth is death]]".to_string(), "plain".to_string()]
            ),
            "riffs-on:\n  - \"[[Growth is death]]\"\n  - plain\n"
        );
        assert_eq!(
            yaml_scalar("date", "2026-09-14 19:00"),
            "date: 2026-09-14 19:00\n"
        );
        assert_eq!(quote("Ember 2026"), "Ember 2026");
        assert_eq!(quote("a: b"), "\"a: b\"");
        assert_eq!(quote("2026"), "\"2026\"");
        assert_eq!(quote("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn written_lists_read_back() {
        let items = vec![
            "[[A#^b]]".to_string(),
            "It's fine".to_string(),
            "x: y".to_string(),
        ];
        let text = format!("---\n{}---\n", yaml_list("k", &items));
        let (fm, _) = parse(&text).unwrap();
        assert_eq!(fm.list("k"), items);
    }
}
