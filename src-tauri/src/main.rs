// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod shortcuts;
mod state;
mod tray;
mod windows;

use commands::index::NoteIndex;
use commands::{cursor_positions, file_watcher, index, notes, settings, share, storage};
use shortcuts::shortcut_to_string;
use state::AppState;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use windows::{show_command_palette, show_main, show_settings};

fn handle_opened_files(app: &AppHandle, paths: Vec<std::path::PathBuf>) {
    for path in paths {
        let is_markdown = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
            .unwrap_or(false);
        if !is_markdown {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();
        if let Err(err) = windows::open_draft(app.clone(), path_str) {
            eprintln!("Failed to open markdown file from Finder: {}", err);
        }
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

                    // Check system shortcuts via dynamic mapping
                    {
                        let state = app.state::<AppState>();
                        let action_map = state
                            .shortcut_to_action
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        let key = shortcut_to_string(shortcut);
                        let action = action_map.get(&key).cloned();
                        drop(action_map);

                        if let Some(action) = action {
                            match action.as_str() {
                                "summon" => {
                                    show_main(app);
                                    return;
                                }
                                "search" => {
                                    show_command_palette(app);
                                    return;
                                }
                                "settings" => {
                                    show_settings(app);
                                    return;
                                }
                                "last_note" => {
                                    let _ = windows::reopen_last_note(app.clone());
                                    return;
                                }
                                _ => {}
                            }
                        }
                    }

                    #[cfg(debug_assertions)]
                    if shortcut.matches(Modifiers::SUPER | Modifiers::ALT, Code::KeyI) {
                        for (_, window) in app.webview_windows() {
                            window.open_devtools();
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
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
            index::rebuild_index,
            settings::get_settings,
            settings::save_settings,
            share::build_clipboard_payload,
            share::copy_rich_text_to_clipboard,
            windows::hide_window,
            windows::hide_main,
            windows::open_draft,
            windows::open_command_palette,
            windows::open_search,
            windows::open_manager,
            windows::open_settings,
            windows::reopen_last_note,
            shortcuts::reload_shortcuts,
            shortcuts::pause_shortcuts,
            shortcuts::resume_shortcuts,
            settings::set_dock_icon_visibility,
            settings::set_tray_icon_visibility,
            settings::save_window_geometry,
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

            shortcuts::register_shortcuts_from_settings(app.handle(), &settings);

            #[cfg(target_os = "macos")]
            if settings.hide_dock_icon {
                settings::apply_dock_icon_visibility(true);
            }

            // Restore window size from settings
            if let Some((w, h)) = settings.window_size {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                }
            }

            tray::setup_tray(app)?;

            // Apply tray icon visibility from settings
            if settings.hide_tray_icon {
                if let Some(tray) = app.tray_by_id("main-tray") {
                    let _ = tray.set_visible(false);
                }
            }

            // Main window: emit blur event so frontend can decide whether to hide
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        if !focused {
                            let _ = w.emit("main-blur", ());
                        }
                    }
                });
            } else {
                eprintln!("Warning: main window not found during setup");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Fatal: Tauri application failed to build: {}", e);
            std::process::exit(1);
        })
        .run(|app, event| {
            if let RunEvent::Opened { urls } = event {
                let paths = urls
                    .into_iter()
                    .filter(|url| url.scheme() == "file")
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                handle_opened_files(app, paths);
            }
        });
}
