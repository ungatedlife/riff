use crate::commands::storage::notes_root;
use crate::state::{AppState, LastSavedNote};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

pub const MAIN: &str = "main";
pub const QUICKIE: &str = "quickie";
pub const SPARK: &str = "spark";
pub const SETTINGS: &str = "settings";
pub const PALETTE: &str = "command-palette";

fn remember_last_note(state: &AppState, path: &str) {
    if path.trim().is_empty() {
        return;
    }

    let mut last = state
        .last_saved_note
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *last = Some(LastSavedNote {
        path: path.to_string(),
    });
}

/// Hard-hide (or restore) the macOS menu bar and Dock while the room is
/// fullscreen. Simple fullscreen's default auto-hide lets the menu bar drop
/// down on a mouse-to-top and — notably when the system already auto-hides
/// it — stick there. The room wants no menu bar at all, so while it's up we
/// take the stronger Hide options; on release the defaults come back.
fn set_immersive_presentation(app: &AppHandle, immersive: bool) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || {
            use objc2::MainThreadMarker;
            use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions};

            if let Some(mtm) = MainThreadMarker::new() {
                let ns_app = NSApplication::sharedApplication(mtm);
                let options = if immersive {
                    NSApplicationPresentationOptions::HideDock
                        | NSApplicationPresentationOptions::HideMenuBar
                } else {
                    NSApplicationPresentationOptions::Default
                };
                ns_app.setPresentationOptions(options);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, immersive);
    }
}

fn set_main_fullscreen_flag(app: &AppHandle, value: bool) {
    let state = app.state::<AppState>();
    let mut flag = state
        .main_fullscreen
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *flag = value;
}

fn main_is_fullscreen(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let flag = state
        .main_fullscreen
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *flag
}

fn main_is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Present the writing room: fullscreen on the monitor the cursor is on —
/// summoning should meet the writer where they are, not where the window
/// last lived. Simple fullscreen (no new macOS space) keeps both the summon
/// and the return instant. Every path that brings the room back goes
/// through here, so it can never reappear as a plain window.
pub fn present_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    if !main_is_fullscreen(app) {
        if let Ok(cursor) = app.cursor_position() {
            if let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) {
                let _ = window.set_position(tauri::Position::Physical(*monitor.position()));
            }
        }
        let _ = window.set_simple_fullscreen(true);
        set_main_fullscreen_flag(app, true);
    }
    set_immersive_presentation(app, true);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Drop out of simple fullscreen after the room hides, so the frame restore
/// happens invisibly and the next summon starts from a clean state.
pub fn release_main_fullscreen(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.set_simple_fullscreen(false);
    }
    set_main_fullscreen_flag(app, false);
    set_immersive_presentation(app, false);
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        present_main(app);
        let _ = window.emit("shortcut-triggered", ());
    }
}

/// After one of Riff's satellite windows hides, hand focus back to the room
/// if it's up. Otherwise macOS activates whatever app is next in line and the
/// fullscreen room sits there without a caret.
pub fn refocus_main(app: &AppHandle) {
    if !main_is_visible(app) {
        return;
    }
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.set_focus();
    }
}

/// The drafts list and Settings are created hidden at launch and only ever
/// shown or hidden, so they appear instantly instead of booting a webview.
pub fn show_command_palette(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PALETTE) {
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("palette-summoned", ());
    }
}

pub fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS) {
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("settings-summoned", ());
    }
}

/// Summon the quickie post-it: a small always-on-top window for a fleeting
/// thought. Centered every time — it's a scratchpad, not a room.
pub fn show_quickie(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICKIE) {
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("quickie-summoned", ());
    }
}

/// Summon the spark window: a line or three that ships the moment ⌘↵ lands.
/// Optional text pre-fills it (a quickie promoted to a spark).
pub fn show_spark(app: &AppHandle, text: Option<String>) {
    if let Some(window) = app.get_webview_window(SPARK) {
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("spark-summoned", ());
        if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
            let _ = window.emit("spark-prefill", serde_json::json!({ "text": text }));
        }
    }
}

/// Hide any Riff window. The room also leaves fullscreen; every other
/// window hands focus back to the room if it's still up.
pub fn hide_by_label(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
    if label == MAIN {
        release_main_fullscreen(app);
    } else {
        refocus_main(app);
    }
}

/// Windows are hidden, never destroyed: ⌘W from the (invisible) default menu
/// or any other close request just tucks the window away. Destroying the
/// room would leave the app running with nothing to summon.
pub fn install_close_guards(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        let handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_by_label(&handle, &label);
            }
        });
    }
}

fn ensure_draft_path(path: &str) -> Result<(), String> {
    let root = notes_root()?;
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let note = Path::new(path);
    let canonical_note = note.canonicalize().unwrap_or_else(|_| note.to_path_buf());
    if canonical_note.starts_with(&canonical_root) {
        Ok(())
    } else {
        Err("Only drafts inside the drafts folder can be opened".to_string())
    }
}

#[tauri::command]
pub fn hide_window(window: tauri::Window, app: AppHandle) {
    hide_by_label(&app, window.label());
}

#[tauri::command]
pub fn hide_main(app: AppHandle) {
    hide_by_label(&app, MAIN);
}

/// Label of the Riff window that has focus right now, if any. The room's
/// blur handler uses it to tell "the writer left for another app" from
/// "the writer opened Settings".
#[tauri::command]
pub fn focused_riff_window(app: AppHandle) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

/// The room calls this once its draft is on disk during an exit.
#[tauri::command]
pub fn flush_complete(app: AppHandle) {
    let state = app.state::<AppState>();
    let (lock, cvar) = &*state.flush_signal;
    let mut done = lock.lock().unwrap_or_else(|e| e.into_inner());
    *done = true;
    cvar.notify_all();
}

/// Load a draft into the writing room: shows + focuses the main window and
/// emits `open-draft` with the file's path and content.
#[tauri::command]
pub fn open_draft(app: AppHandle, path: String) -> Result<(), String> {
    ensure_draft_path(&path)?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {}", e))?;

    {
        let state = app.state::<AppState>();
        remember_last_note(&state, &path);
    }

    if let Some(window) = app.get_webview_window(MAIN) {
        present_main(&app);
        let _ = window.emit(
            "open-draft",
            serde_json::json!({ "path": path, "content": content }),
        );
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub fn open_command_palette(app: AppHandle) -> Result<bool, String> {
    show_command_palette(&app);
    Ok(true)
}

#[tauri::command]
pub fn open_quickie(app: AppHandle) {
    show_quickie(&app);
}

#[tauri::command]
pub fn open_spark(app: AppHandle, text: Option<String>) {
    show_spark(&app, text);
}

/// The welcome screen's last step: straight into the room.
#[tauri::command]
pub fn open_room(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<bool, String> {
    show_settings(&app);
    Ok(true)
}

#[tauri::command]
pub fn reopen_last_note(app: AppHandle) -> Result<(), String> {
    let path = {
        let state = app.state::<AppState>();
        let last = state
            .last_saved_note
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match last.as_ref() {
            Some(note) => note.path.clone(),
            None => return Err("No recent draft".to_string()),
        }
    };

    open_draft(app, path)
}

#[cfg(test)]
mod tests {
    use super::remember_last_note;
    use crate::state::AppState;

    #[test]
    fn remember_last_note_updates_state_for_shortcuts() {
        let state = AppState::new();
        remember_last_note(&state, "/tmp/riff/foo.md");

        let last = state
            .last_saved_note
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let note = last.as_ref().expect("last note should be set");
        assert_eq!(note.path, "/tmp/riff/foo.md");
    }

    #[test]
    fn fullscreen_flag_starts_false() {
        let state = AppState::new();
        assert!(!*state.main_fullscreen.lock().unwrap());
    }
}
