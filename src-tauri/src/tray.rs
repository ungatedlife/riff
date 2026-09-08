use crate::commands::settings;
use crate::state::AppState;
use crate::windows::{show_command_palette, show_main, show_quickie, show_settings};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Manager};

/// The menu bar menu is Riff's front door: both capture surfaces, the drafts
/// list, and the two switches that matter for a background app.
pub fn setup_tray(app: &App, launch_at_login: bool) -> Result<(), Box<dyn std::error::Error>> {
    let new_note = MenuItem::with_id(app, "new_note", "Open Riff", true, None::<&str>)?;
    let new_quickie = MenuItem::with_id(app, "new_quickie", "Open Quickie", true, None::<&str>)?;
    let drafts = MenuItem::with_id(app, "drafts", "Drafts…", true, None::<&str>)?;
    let launch = CheckMenuItem::with_id(
        app,
        "launch_at_login",
        "Launch at Login",
        true,
        launch_at_login,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Riff", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &new_note,
            &new_quickie,
            &drafts,
            &PredefinedMenuItem::separator(app)?,
            &launch,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    {
        let state = app.state::<AppState>();
        let mut item = state
            .launch_at_login_item
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *item = Some(launch.clone());
    }

    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "new_note" => show_main(app),
            "new_quickie" => show_quickie(app),
            "drafts" => show_command_palette(app),
            "launch_at_login" => settings::toggle_launch_at_login(app),
            "settings" => show_settings(app),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
