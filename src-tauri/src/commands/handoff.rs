/// A passage handed to Riff by another app (Trove, the reading app), to
/// start a spark or a riff that responds to it.
///
/// The other app does two things:
///   1. writes `~/.riff/handoffs/<id>.json` with the passage and where it
///      is from (`quote`, `link`, `title`, `author`, `page`);
///   2. opens `riff://spark?handoff=<id>` or `riff://riff?handoff=<id>`.
///
/// Riff reads the file, deletes it, and keeps the passage until the door's
/// window asks for it with `take_handoff`. The window is told with a
/// `handoff` event, but it also asks when it boots: if the URL is what
/// launched Riff, the event went out before any window could hear it.
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Url};

use super::connections::Quote;
use super::settings;
use crate::state::AppState;
use crate::windows;

/// The two doors a passage can be handed to.
const SPARK: &str = "spark";
const RIFF: &str = "riff";

/// The event a door's window hears when a passage is waiting for it.
const HANDOFF_EVENT: &str = "handoff";

/// The handoff file as the other app writes it. It also has a `kind`
/// ("spark" or "riff"), which repeats the door named in the URL and is not
/// read here.
#[derive(Deserialize)]
struct HandoffFile {
    quote: String,
    link: Option<String>,
    title: Option<String>,
    author: Option<String>,
    page: Option<String>,
}

/// An id is 1 to 64 letters, digits and hyphens: nothing that could point
/// at a file outside the handoffs folder (no dots, no slashes).
fn is_valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `~/.riff/handoffs`, beside the settings file.
fn handoffs_dir() -> Result<PathBuf, String> {
    Ok(settings::get_settings_path()?.with_file_name("handoffs"))
}

/// Read `<dir>/<id>.json`, delete it, and return the passage it carried.
/// None for a bad id, a missing file, or a file that isn't a handoff.
fn take_file(dir: &Path, id: &str) -> Option<Quote> {
    if !is_valid_id(id) {
        return None;
    }
    let path = dir.join(format!("{}.json", id));
    let data = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    let file: HandoffFile = serde_json::from_str(&data).ok()?;
    Quote {
        text: file.quote,
        title: file.title.unwrap_or_default(),
        author: file.author.unwrap_or_default(),
        page: file.page.unwrap_or_default(),
        link: file.link.unwrap_or_default(),
    }
    .normalized()
}

/// What a `riff://` URL asks for: the door, and the handoff id if it has
/// one. None for any URL that isn't one of ours.
fn parse_url(url: &Url) -> Option<(&'static str, Option<String>)> {
    if url.scheme() != "riff" {
        return None;
    }
    let door = match url.host_str()? {
        "spark" => SPARK,
        "riff" => RIFF,
        _ => return None,
    };
    let id = url
        .query_pairs()
        .find(|(key, _)| key == "handoff")
        .map(|(_, value)| value.into_owned());
    Some((door, id))
}

fn window_label(door: &str) -> &'static str {
    if door == SPARK {
        windows::SPARK
    } else {
        windows::MAIN
    }
}

fn show_door(app: &AppHandle, door: &str) {
    if door == SPARK {
        windows::show_spark(app, None);
    } else {
        windows::show_main(app);
    }
}

/// Another app opened a `riff://` URL. Pick up the passage it points at,
/// if there is one, and show the door. A missing or broken handoff file
/// just shows the door.
pub fn open_url(app: &AppHandle, url: &Url) {
    let Some((door, id)) = parse_url(url) else {
        return;
    };
    let quote = id.and_then(|id| take_file(&handoffs_dir().ok()?, &id));
    let has_quote = quote.is_some();

    let state = app.state::<AppState>();
    if let Some(quote) = quote {
        state
            .pending_handoffs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(door.to_string(), quote);
    }

    let label = window_label(door);
    if app.get_webview_window(label).is_none() {
        // The URL is what launched Riff and its windows aren't built yet.
        // `show_waiting_door` opens the door once they are.
        *state.door_waiting.lock().unwrap_or_else(|e| e.into_inner()) = Some(door);
        return;
    }

    show_door(app, door);
    if has_quote {
        let _ = app.emit_to(EventTarget::labeled(label), HANDOFF_EVENT, ());
    }
}

/// Called once Riff has finished launching: show the door a `riff://` URL
/// asked for before the windows existed. The window picks the passage up
/// itself, with `take_handoff`, when it boots.
pub fn show_waiting_door(app: &AppHandle) {
    let door = app
        .state::<AppState>()
        .door_waiting
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(door) = door {
        show_door(app, door);
    }
}

/// The passage waiting for this door ("spark" or "riff"), if any. Taking
/// it clears it, so it is attached once.
#[tauri::command]
pub fn take_handoff(door: String, state: State<'_, AppState>) -> Option<Quote> {
    state
        .pending_handoffs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&door)
}

#[cfg(test)]
mod tests {
    use super::{is_valid_id, parse_url, take_file};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::Url;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("riff-handoff-{}-{}", tag, unique));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    const FULL: &str = r#"{
        "kind": "spark",
        "quote": "All real living is meeting.\n\nSecond paragraph of the passage.",
        "link": "I and Thou#^3fa9c2",
        "title": "I and Thou",
        "author": "Martin Buber",
        "page": "11"
    }"#;

    #[test]
    fn ids_are_letters_digits_and_hyphens_only() {
        assert!(is_valid_id("3fa9c2-abc"));
        assert!(is_valid_id(&"a".repeat(64)));
        assert!(!is_valid_id("../x"));
        assert!(!is_valid_id("a/b"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id(&"a".repeat(65)));
        assert!(!is_valid_id("a.json"));
        assert!(!is_valid_id("a b"));
        assert!(!is_valid_id("é"));
    }

    #[test]
    fn a_handoff_file_is_read_once_and_then_gone() {
        let dir = temp_dir("take");
        fs::write(dir.join("3fa9c2-abc.json"), FULL).unwrap();

        let quote = take_file(&dir, "3fa9c2-abc").expect("a quote");
        assert_eq!(
            quote.text,
            "All real living is meeting.\n\nSecond paragraph of the passage."
        );
        assert_eq!(quote.link, "I and Thou#^3fa9c2");
        assert_eq!(quote.title, "I and Thou");
        assert_eq!(quote.author, "Martin Buber");
        assert_eq!(quote.page, "11");

        assert!(!dir.join("3fa9c2-abc.json").exists());
        assert!(take_file(&dir, "3fa9c2-abc").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_link_and_the_rest_of_the_attribution_are_optional() {
        let dir = temp_dir("optional");
        fs::write(
            dir.join("a.json"),
            r#"{"kind":"riff","quote":"Just the words.","title":"A book","author":"","page":""}"#,
        )
        .unwrap();
        let quote = take_file(&dir, "a").expect("a quote");
        assert_eq!(quote.text, "Just the words.");
        assert_eq!(quote.title, "A book");
        assert!(quote.link.is_empty() && quote.author.is_empty() && quote.page.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_id_never_reaches_a_file_outside_the_folder() {
        let root = temp_dir("escape");
        let dir = root.join("handoffs");
        fs::create_dir_all(&dir).unwrap();
        fs::write(root.join("x.json"), FULL).unwrap();

        assert!(take_file(&dir, "../x").is_none());
        // Still there: it was neither read nor deleted.
        assert!(root.join("x.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_and_malformed_files_give_nothing() {
        let dir = temp_dir("broken");
        assert!(take_file(&dir, "nothing-here").is_none());

        fs::write(dir.join("not-json.json"), "hello").unwrap();
        assert!(take_file(&dir, "not-json").is_none());

        fs::write(
            dir.join("no-quote.json"),
            r#"{"kind":"spark","title":"A book"}"#,
        )
        .unwrap();
        assert!(take_file(&dir, "no-quote").is_none());

        fs::write(
            dir.join("empty-quote.json"),
            r#"{"kind":"spark","quote":"  "}"#,
        )
        .unwrap();
        assert!(take_file(&dir, "empty-quote").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn urls_name_a_door_and_maybe_a_handoff() {
        let parse = |s: &str| parse_url(&Url::parse(s).unwrap());
        assert_eq!(
            parse("riff://spark?handoff=3fa9c2-abc"),
            Some(("spark", Some("3fa9c2-abc".to_string())))
        );
        assert_eq!(
            parse("riff://riff?handoff=abc"),
            Some(("riff", Some("abc".to_string())))
        );
        assert_eq!(parse("riff://spark"), Some(("spark", None)));
        assert_eq!(parse("riff://quickie?handoff=abc"), None);
        assert_eq!(parse("https://spark?handoff=abc"), None);
        // Whatever the id says, it is checked again before a file is touched.
        assert_eq!(
            parse("riff://spark?handoff=../x"),
            Some(("spark", Some("../x".to_string())))
        );
    }
}
