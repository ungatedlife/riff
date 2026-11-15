use crate::commands::settings;
use crate::state::AppState;
use crate::updates;
use crate::windows::{show_command_palette, show_main, show_quickie, show_settings, show_spark};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Manager};

/// The menu bar menu is Riff's front door: the three doors, the drafts
/// list, a manual site publish, the two switches that matter for a
/// background app, and which version this is with a way to update it.
pub fn setup_tray(app: &App, launch_at_login: bool) -> Result<(), Box<dyn std::error::Error>> {
    let new_note = MenuItem::with_id(app, "new_note", "Riff", true, None::<&str>)?;
    let new_spark = MenuItem::with_id(app, "new_spark", "Spark", true, None::<&str>)?;
    let new_quickie = MenuItem::with_id(app, "new_quickie", "Quickie", true, None::<&str>)?;
    let publish = MenuItem::with_id(
        app,
        "publish_site",
        crate::commands::site::MENU_PUBLISH,
        true,
        None::<&str>,
    )?;
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
    let version = MenuItem::with_id(
        app,
        "version",
        format!("Riff {}", app.package_info().version),
        false,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(
        app,
        "check_updates",
        updates::MENU_CHECK,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Riff", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &new_note,
            &new_spark,
            &new_quickie,
            &drafts,
            &PredefinedMenuItem::separator(app)?,
            &publish,
            &PredefinedMenuItem::separator(app)?,
            &launch,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &version,
            &update,
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
        *state.update_item.lock().unwrap_or_else(|e| e.into_inner()) = Some(update.clone());
        *state.publish_item.lock().unwrap_or_else(|e| e.into_inner()) = Some(publish.clone());
    }

    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "new_note" => show_main(app),
            "new_spark" => show_spark(app, None),
            "new_quickie" => show_quickie(app),
            "publish_site" => {
                // Asked for from the menu bar, there may be no window open to
                // show why it couldn't start, so say it as a notification too.
                if let Err(e) = crate::commands::site::request_site_publish(app) {
                    crate::commands::site::notify(app, "The site didn't publish", &e);
                    let _ = tauri::Emitter::emit(
                        app,
                        crate::commands::site::EVENT,
                        crate::commands::site::SitePublishEvent {
                            phase: "failed".into(),
                            detail: e,
                        },
                    );
                }
            }
            "drafts" => show_command_palette(app),
            "launch_at_login" => settings::toggle_launch_at_login(app),
            "settings" => show_settings(app),
            "check_updates" => updates::menu_clicked(app),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
