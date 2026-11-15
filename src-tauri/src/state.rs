use crate::commands::connections::Quote;
use crate::commands::site::SitePublishState;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use tauri::menu::CheckMenuItem;
use tauri::Wry;

pub struct LastSavedNote {
    pub path: String,
}

pub struct AppState {
    pub shortcut_to_action: Mutex<HashMap<String, String>>,
    pub last_saved_note: Mutex<Option<LastSavedNote>>,
    /// True while the room is presented in simple fullscreen.
    pub main_fullscreen: Mutex<bool>,
    /// Set once an exit has been intercepted to flush the room's draft; the
    /// second `ExitRequested` (raised by our own `app.exit`) passes through.
    pub exit_flushing: Mutex<bool>,
    /// `(done, signal)`: the room reports its final save through this.
    pub flush_signal: Arc<(Mutex<bool>, Condvar)>,
    /// The "Launch at Login" check item in the menu bar menu, so settings
    /// changes made elsewhere can keep its tick in sync.
    pub launch_at_login_item: Mutex<Option<CheckMenuItem<Wry>>>,
    /// One site publish at a time; a second request while one runs queues
    /// exactly one more.
    pub site_publish: Mutex<SitePublishState>,
    /// Passages handed over by another app (Trove), keyed by the door they
    /// are for ("spark" or "riff"), waiting for that door's window to take
    /// them. See `commands/handoff.rs`.
    pub pending_handoffs: Mutex<HashMap<String, Quote>>,
    /// The door a `riff://` URL asked for before the windows existed (the
    /// URL is what launched Riff). Shown as soon as the app is ready.
    pub door_waiting: Mutex<Option<&'static str>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            shortcut_to_action: Mutex::new(HashMap::new()),
            last_saved_note: Mutex::new(None),
            main_fullscreen: Mutex::new(false),
            exit_flushing: Mutex::new(false),
            flush_signal: Arc::new((Mutex::new(false), Condvar::new())),
            launch_at_login_item: Mutex::new(None),
            site_publish: Mutex::new(SitePublishState::default()),
            pending_handoffs: Mutex::new(HashMap::new()),
            door_waiting: Mutex::new(None),
        }
    }
}
