use crate::windows::{show_main, show_quickie, show_settings};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::App;

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "Quit Riff", true, None::<&str>)?;
    let new_note = MenuItem::with_id(app, "new_note", "New Riff", true, None::<&str>)?;
    let new_quickie = MenuItem::with_id(app, "new_quickie", "New Quickie", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&new_note, &new_quickie, &separator, &settings, &quit],
    )?;

    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                app.exit(0);
            }
            "new_note" => {
                show_main(app);
            }
            "new_quickie" => {
                show_quickie(app);
            }
            "settings" => {
                show_settings(app);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
