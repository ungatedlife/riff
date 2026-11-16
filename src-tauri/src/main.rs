// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod shortcuts;
mod state;
mod tray;
mod updates;
mod veil;
mod windows;

use commands::index::NoteIndex;
use commands::{
    connections, cursor_positions, file_watcher, handoff, index, notes, publish, quickies,
    settings, share, site, storage, vault,
};
use shortcuts::shortcut_to_string;
use state::AppState;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, EventTarget, Manager, RunEvent};
use tauri_plugin_global_shortcut::ShortcutState;
use windows::{show_main, show_quickie, show_spark};

/// How long an exit waits for the room to finish writing its draft. The
/// save itself takes a few milliseconds; the timeout only matters if the
/// webview is unresponsive.
pub(crate) const EXIT_FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);

pub(crate) fn wait_for_flush(app: &AppHandle, timeout: Duration) {
    let state = app.state::<AppState>();
    let (lock, cvar) = &*state.flush_signal;
    let mut done = lock.lock().unwrap_or_else(|e| e.into_inner());
    let deadline = Instant::now() + timeout;
    while !*done {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let (guard, _) = cvar
            .wait_timeout(done, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        done = guard;
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::new())
        .manage(NoteIndex::new())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    // Only the three doors are reachable from other apps;
                    // everything else is handled inside Riff's windows.
                    {
                        let state = app.state::<AppState>();
                        let action_map = state
                            .shortcut_to_action
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        let key = shortcut_to_string(shortcut);
                        let action = action_map.get(&key).cloned();
                        drop(action_map);

                        match action.as_deref() {
                            Some("summon") => {
                                show_main(app);
                                return;
                            }
                            Some("spark") => {
                                show_spark(app, None);
                                return;
                            }
                            Some("quickie") => {
                                show_quickie(app);
                                return;
                            }
                            _ => {}
                        }
                    }

                    #[cfg(debug_assertions)]
                    {
                        use tauri_plugin_global_shortcut::{Code, Modifiers};
                        if shortcut.matches(Modifiers::SUPER | Modifiers::ALT, Code::KeyI) {
                            for (_, window) in app.webview_windows() {
                                window.open_devtools();
                            }
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            notes::save_note,
            notes::update_note,
            notes::list_notes,
            notes::search_notes,
            notes::delete_note,
            notes::get_note_content,
            notes::save_note_image,
            notes::save_note_image_from_path,
            storage::get_drafts_directory,
            publish::publish_riff,
            publish::publish_spark,
            site::publish_site,
            site::site_publish_failure,
            connections::get_connections,
            connections::save_connections,
            connections::remove_connections,
            handoff::take_handoff,
            quickies::append_quickie,
            quickies::save_quickie_draft,
            quickies::get_quickie_draft,
            quickies::save_spark_draft,
            quickies::get_spark_draft,
            vault::search_vault_links,
            vault::open_vault_note,
            vault::vault_vocabulary,
            index::rebuild_index,
            settings::get_settings,
            settings::save_settings,
            share::build_clipboard_payload,
            share::copy_rich_text_to_clipboard,
            windows::hide_window,
            windows::hide_main,
            windows::open_draft,
            windows::open_command_palette,
            windows::open_settings,
            windows::open_room,
            windows::open_quickie,
            windows::open_spark,
            windows::reopen_last_note,
            windows::focused_riff_window,
            windows::flush_complete,
            shortcuts::reload_shortcuts,
            shortcuts::pause_shortcuts,
            shortcuts::resume_shortcuts,
            settings::set_dock_icon_visibility,
            settings::set_tray_icon_visibility,
            settings::import_theme_file,
            settings::export_theme_file,
            cursor_positions::get_cursor_position,
            cursor_positions::save_cursor_position,
            cursor_positions::remove_cursor_position,
        ])
        .setup(|app| {
            let settings = settings::get_settings().unwrap_or_default();

            // Build the in-memory note index and watch for external changes
            let index = app.state::<NoteIndex>();
            if let Err(e) = index.build() {
                eprintln!("Failed to build note index: {}", e);
            }
            file_watcher::start(app.handle().clone());

            // The isolated UI test build leaves the installed app's hotkeys alone.
            if !(cfg!(debug_assertions) && option_env!("RIFF_TEST_HOME").is_some()) {
                shortcuts::register_shortcuts_from_settings(app.handle(), &settings);
            }

            #[cfg(target_os = "macos")]
            if settings.hide_dock_icon {
                settings::apply_dock_icon_visibility(true);
            }

            tray::setup_tray(app, settings.launch_at_login)?;

            // A menu-bar app with neither icon is unreachable; the loader
            // already refuses that combination, so this only applies the
            // sanitized value.
            if settings.hide_tray_icon {
                if let Some(tray) = app.tray_by_id("main-tray") {
                    let _ = tray.set_visible(false);
                }
            }

            settings::apply_launch_at_login(app.handle(), settings.launch_at_login);

            // A new install opens on the welcome screen, which lives in the
            // Settings window. Riff has no Dock icon, so without it a first
            // launch would show nothing at all.
            if !settings.welcomed {
                windows::show_settings(app.handle());
            }

            // Look for a newer Riff now and then (see updates.rs).
            updates::start(app.handle());

            // Every window hides instead of closing.
            windows::install_close_guards(app.handle());
            veil::install(app.handle());

            // Debug builds can be launched straight into a door for
            // verification: `Riff.app --open=spark|quickie|main` (the
            // isolated test build has no hotkeys to summon them with).
            #[cfg(debug_assertions)]
            if let Some(door) =
                std::env::args().find_map(|a| a.strip_prefix("--open=").map(String::from))
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(800));
                    match door.as_str() {
                        "spark" => show_spark(&handle, None),
                        "quickie" => show_quickie(&handle),
                        _ => show_main(&handle),
                    }
                });
            }

            // Capture surfaces emit a blur event so the frontend can decide
            // whether to tuck themselves away.
            for label in [windows::MAIN, windows::QUICKIE, windows::SPARK] {
                if let Some(window) = app.get_webview_window(label) {
                    let w = window.clone();
                    let event_name = format!("{}-blur", label);
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::Focused(false) = event {
                            let _ = w.emit(&event_name, ());
                        }
                    });
                } else {
                    eprintln!("Warning: {} window not found during setup", label);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Fatal: Tauri application failed to build: {}", e);
            std::process::exit(1);
        })
        .run(|app, event| {
            // Another app (Trove) opened `riff://spark?handoff=…` or
            // `riff://riff?handoff=…`: a passage to respond to.
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                for url in urls {
                    handoff::open_url(app, url);
                }
            }
            // If that URL is what launched Riff, it arrived before the
            // windows existed. They do now, so its door can open.
            if let RunEvent::Ready = &event {
                handoff::show_waiting_door(app);
            }

            // Quit (menu bar, ⌘Q) waits for the room to write its draft first.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                let already_flushing = {
                    let state = app.state::<AppState>();
                    let mut flushing = state
                        .exit_flushing
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    let was = *flushing;
                    *flushing = true;
                    was
                };
                if already_flushing {
                    return; // our own exit after the flush — let it through
                }

                api.prevent_exit();
                let _ = app.emit_to(EventTarget::labeled(windows::MAIN), "flush-drafts", ());

                let handle = app.clone();
                let code = code.unwrap_or(0);
                std::thread::spawn(move || {
                    wait_for_flush(&handle, EXIT_FLUSH_TIMEOUT);
                    handle.exit(code);
                });
            }
        });
}
