/// Riff keeps itself current. A little after launch, and every few hours
/// while it sits in the menu bar, it asks the release feed whether there is
/// a newer version. If there is, it downloads it, checks the download
/// against the update key built into this copy, and puts it in place. The
/// new version is what opens next time; "Restart to Update" in the menu bar
/// switches to it right away.
///
/// The feed address and the key are in `tauri.conf.json` under
/// `plugins.updater`. `scripts/release.sh` writes the feed.
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;
use crate::windows;

/// Long enough after launch that the check never competes with the first
/// hotkey press.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
/// A menu bar app can run for weeks, so launch is not often enough.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

pub const MENU_CHECK: &str = "Check for Updates…";

pub fn menu_restart(version: &str) -> String {
    format!("Restart to Update to {}", version)
}

enum Outcome {
    UpToDate,
    Installed(String),
}

async fn check_and_install(app: &AppHandle) -> Result<Outcome, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(Outcome::UpToDate);
    };
    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(Outcome::Installed(version))
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// One check. `asked` is true when it came from the menu bar: then every
/// outcome gets an answer. The background check only speaks up when it has
/// installed something.
async fn run(app: &AppHandle, asked: bool) {
    let state = app.state::<AppState>();
    if state.update_checking.swap(true, Ordering::SeqCst) {
        return; // one at a time
    }
    let outcome = check_and_install(app).await;
    state.update_checking.store(false, Ordering::SeqCst);

    match outcome {
        Ok(Outcome::Installed(version)) => {
            eprintln!("update: installed {}", version);
            *state.update_ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(version.clone());
            if let Some(item) = state
                .update_item
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
            {
                let _ = item.set_text(menu_restart(&version));
            }
            notify(
                app,
                &format!("Riff {} is ready", version),
                "It opens the next time Riff starts. To switch now, choose Restart to Update in the menu bar.",
            );
        }
        Ok(Outcome::UpToDate) => {
            eprintln!("update: up to date");
            if asked {
                notify(
                    app,
                    "Riff is up to date",
                    &format!(
                        "This is {}, the newest version.",
                        app.package_info().version
                    ),
                );
            }
        }
        Err(e) => {
            eprintln!("update: {}", e);
            if asked {
                notify(app, "Couldn't check for updates", &e);
            }
        }
    }
}

/// Begin the background checks. A build run from the source folder leaves
/// itself alone unless `RIFF_UPDATE_CHECK` is set, which is how the updater
/// gets tested without touching the installed copy.
pub fn start(app: &AppHandle) {
    let testing = std::env::var_os("RIFF_UPDATE_CHECK").is_some();
    if cfg!(debug_assertions) && !testing {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(if testing {
            Duration::from_secs(2)
        } else {
            FIRST_CHECK_AFTER
        })
        .await;
        loop {
            run(&handle, false).await;
            tokio_sleep(CHECK_EVERY).await;
        }
    });
}

/// The async runtime's own sleep would need another dependency; a blocking
/// sleep on its blocking pool does the same job for a timer this coarse.
async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

/// The menu bar item. Before an update is in place it checks; after, it
/// restarts into the new version.
pub fn menu_clicked(app: &AppHandle) {
    let ready = app
        .state::<AppState>()
        .update_ready
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    if ready {
        restart(app);
    } else {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { run(&handle, true).await });
    }
}

/// Restart into the version just installed, once the room has written its
/// draft. Marking the exit as already flushing lets the restart pass
/// straight through the quit handler in `main.rs`.
fn restart(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        *state
            .exit_flushing
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = true;
    }
    let _ = app.emit_to(EventTarget::labeled(windows::MAIN), "flush-drafts", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        crate::wait_for_flush(&handle, crate::EXIT_FLUSH_TIMEOUT);
        handle.request_restart();
    });
}

#[cfg(test)]
mod tests {
    use super::{menu_restart, MENU_CHECK};

    #[test]
    fn the_menu_item_names_the_version_it_will_restart_into() {
        assert_eq!(menu_restart("0.4.1"), "Restart to Update to 0.4.1");
        assert_ne!(menu_restart("0.4.1"), MENU_CHECK);
    }
}
