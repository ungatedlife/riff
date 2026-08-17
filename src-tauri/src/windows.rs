use crate::commands::settings;
use crate::state::{AppState, LastSavedNote};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const SETTINGS_WINDOW_WIDTH: f64 = 860.0;
const SETTINGS_WINDOW_HEIGHT: f64 = 720.0;
const SETTINGS_WINDOW_MIN_WIDTH: f64 = 760.0;
const SETTINGS_WINDOW_MIN_HEIGHT: f64 = 560.0;

const MAIN_DEFAULT_WIDTH: f64 = 680.0;
const MAIN_DEFAULT_HEIGHT: f64 = 540.0;

/// Minimum overlap (in physical pixels) between window and monitor for the position to be usable.
const MIN_OVERLAP: f64 = 80.0;

/// Check if a window at (x, y) with the given size overlaps sufficiently with any connected
/// monitor. All coordinates are in **physical pixels** (same space as `outerPosition()`).
/// Uses rectangle intersection — handles negative coordinates from left/top monitors.
fn is_window_visible_on_any_monitor(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> bool {
    let monitors = app
        .get_webview_window("main")
        .and_then(|win| win.available_monitors().ok());

    let Some(monitors) = monitors else {
        return false;
    };

    for monitor in monitors {
        let pos = monitor.position();
        let size = monitor.size();

        // All values in physical pixels — no scale conversion needed.
        let mx = pos.x as f64;
        let my = pos.y as f64;
        let mw = size.width as f64;
        let mh = size.height as f64;

        // Rectangle intersection: overlap width/height between window and monitor
        let overlap_w = (x + w).min(mx + mw) - x.max(mx);
        let overlap_h = (y + h).min(my + mh) - y.max(my);

        if overlap_w >= MIN_OVERLAP && overlap_h >= MIN_OVERLAP {
            return true;
        }
    }

    false
}

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

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(s) = settings::load_settings_from_file() {
            // Restore persisted window size
            let (w, h) = s
                .window_size
                .unwrap_or((MAIN_DEFAULT_WIDTH, MAIN_DEFAULT_HEIGHT));
            if s.window_size.is_some() {
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
            }
            // Restore position only if it's visible on a connected monitor.
            if let Some((x, y)) = s.window_position {
                if is_window_visible_on_any_monitor(app, x, y, w, h) {
                    let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(
                        x as i32, y as i32,
                    )));
                } else {
                    let _ = window.center();
                }
            }
        }
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("shortcut-triggered", ());
    }
}

fn store_main_visibility(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut visible = state
        .main_was_visible
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *visible = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
}

/// After the palette or settings window closes, bring the writing room back
/// if it was visible before — without this the room strands behind other apps.
fn refocus_main_if_it_was_visible(app: &AppHandle) {
    let state = app.state::<AppState>();
    let visible = *state
        .main_was_visible
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    if visible {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
}

pub fn show_command_palette(app: &AppHandle) {
    store_main_visibility(app);

    if let Some(window) = app.get_webview_window("command-palette") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let window = WebviewWindowBuilder::new(
        app,
        "command-palette",
        WebviewUrl::App("index.html?window=command-palette".into()),
    )
    .title("Command Palette")
    .inner_size(700.0, 480.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build();

    if let Ok(win) = window {
        let app_handle = app.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                refocus_main_if_it_was_visible(&app_handle);
            }
        });
    }
}

pub fn show_settings(app: &AppHandle) {
    store_main_visibility(app);

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let window = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?window=settings".into()),
    )
    .title("Settings")
    .inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
    .min_inner_size(SETTINGS_WINDOW_MIN_WIDTH, SETTINGS_WINDOW_MIN_HEIGHT)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build();

    if let Ok(win) = window {
        let app_handle = app.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                refocus_main_if_it_was_visible(&app_handle);
            }
        });
    }
}

/// Summon the quickie post-it: a small always-on-top window for a fleeting
/// thought. Centered every time — it's a scratchpad, not a room.
pub fn show_quickie(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("quickie") {
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("quickie-summoned", ());
    }
}

#[tauri::command]
pub fn hide_window(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
pub fn hide_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Load a draft into the writing room: shows + focuses the main window and
/// emits `open-draft` with the file's path and content.
#[tauri::command]
pub fn open_draft(app: AppHandle, path: String) -> Result<(), String> {
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {}", e))?;

    {
        let state = app.state::<AppState>();
        remember_last_note(&state, &path);
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
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
pub fn open_search(app: AppHandle) -> Result<bool, String> {
    show_command_palette(&app);
    Ok(true)
}

#[tauri::command]
pub fn open_manager(app: AppHandle) -> Result<bool, String> {
    show_command_palette(&app);
    Ok(true)
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
            None => return Err("No note saved yet".to_string()),
        }
    };

    open_draft(app, path)
}

#[cfg(test)]
mod tests {
    use super::{remember_last_note, SETTINGS_WINDOW_MIN_WIDTH, SETTINGS_WINDOW_WIDTH};
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
    fn settings_window_min_width_is_large_enough_for_full_menu_bar() {
        assert!(SETTINGS_WINDOW_MIN_WIDTH >= 760.0);
        assert!(SETTINGS_WINDOW_WIDTH > SETTINGS_WINDOW_MIN_WIDTH);
    }
}
