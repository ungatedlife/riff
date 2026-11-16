//! The veil: noise-cancelling for the screen while a spark is being written.
//!
//! When the spark window (or the quickie) has the keyboard, a full-screen sheet of
//! the Mac's own frosted glass goes up behind it, so the words you are answering
//! and the rest of the screen blur away and only the little window stays sharp.
//! The same glass Monocle uses, but Riff's own, so it works whatever Monocle is set to.
//!
//! How it sits:
//!   - The spark and quickie windows float (always on top). The veil is an ordinary
//!     window, put in front of every other ordinary window, so it covers the apps
//!     behind and stays under the floating window.
//!   - It never takes the keyboard (not focusable), and clicks go straight through it,
//!     so clicking anywhere else works as before: the spark loses the keyboard and the
//!     veil comes down with it.
//!   - It covers the screen the floating window is on.
use crate::windows::{QUICKIE, SPARK};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectState};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const VEIL: &str = "veil";

/// The windows that get the veil behind them.
const VEILED: [&str; 2] = [SPARK, QUICKIE];

/// The veil window, made the first time it is needed and then kept, hidden.
fn veil(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(VEIL) {
        return Some(window);
    }
    WebviewWindowBuilder::new(app, VEIL, WebviewUrl::App("veil.html".into()))
        .title("")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .effects(WindowEffectsConfig {
            effects: vec![Effect::HudWindow],
            state: Some(EffectState::Active),
            radius: None,
            color: None,
        })
        .build()
        .ok()
}

/// Puts the veil up behind a floating window, on that window's screen.
fn raise_behind(app: &AppHandle, label: &str) {
    let Some(front) = app.get_webview_window(label) else {
        return;
    };
    let Some(veil) = veil(app) else {
        return;
    };
    if let Ok(Some(monitor)) = front.current_monitor() {
        let _ = veil.set_position(tauri::Position::Physical(*monitor.position()));
        let _ = veil.set_size(tauri::Size::Physical(*monitor.size()));
    }
    let _ = veil.set_ignore_cursor_events(true);
    // Not focusable, so this only brings it forward: the floating window keeps the keyboard.
    let _ = veil.show();
}

/// Takes the veil down.
fn lower(app: &AppHandle) {
    if let Some(veil) = app.get_webview_window(VEIL) {
        let _ = veil.hide();
    }
}

/// The veil follows the keyboard: up while the spark or the quickie has it, down when it goes.
pub fn install(app: &AppHandle) {
    for label in VEILED {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        let handle = app.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::Focused(focused) = event {
                if *focused {
                    raise_behind(&handle, label);
                } else {
                    lower(&handle);
                }
            }
        });
    }
}
