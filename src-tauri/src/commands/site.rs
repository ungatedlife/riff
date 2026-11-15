/// What runs after something ships. Riff itself only writes Markdown into a
/// folder; anything beyond that (publishing a website, syncing, a backup) is
/// a script the writer chooses in Settings → Files. Riff runs it in the
/// background, one run at a time — a spark that lands mid-run queues one
/// more run rather than racing the first — and reports how it went.
///
/// The setting may also name a folder: then the script is the
/// `Publish.command` inside it. (That is how Rob's site works: his site
/// repo's Publish.command syncs the vault, builds, and pushes.)
///
/// A script's last line starting with ✓ (or "Nothing new") becomes the
/// summary Riff shows; on failure, its last few lines do.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use super::settings;
use crate::state::AppState;

#[derive(Debug, Default)]
pub struct SitePublishState {
    pub running: bool,
    pub pending: bool,
    /// Why the last publish failed, until one succeeds. A spark's window is
    /// gone long before its publish finishes, so the failure has to wait
    /// somewhere it will be seen: the menu bar, and the next door opened.
    pub last_failure: Option<String>,
}

pub const MENU_PUBLISH: &str = "Publish the site";
pub const MENU_PUBLISH_AGAIN: &str = "Publish the site again (the last one failed)";

/// Remember how the last publish ended, and let the menu bar say so.
fn record_outcome(app: &AppHandle, failure: Option<String>) {
    let state = app.state::<AppState>();
    let failed = failure.is_some();
    state
        .site_publish
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last_failure = failure;
    let item = state.publish_item.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(item) = item.as_ref() {
        let _ = item.set_text(if failed {
            MENU_PUBLISH_AGAIN
        } else {
            MENU_PUBLISH
        });
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SitePublishEvent {
    /// `started` · `done` · `failed`
    pub phase: String,
    pub detail: String,
}

pub const EVENT: &str = "site-publish";

fn emit(app: &AppHandle, phase: &str, detail: impl Into<String>) {
    let _ = app.emit(
        EVENT,
        SitePublishEvent {
            phase: phase.to_string(),
            detail: detail.into(),
        },
    );
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// The script a chosen path stands for: the file itself, or the
/// `Publish.command` in a chosen folder.
pub fn resolve_script(chosen: &Path) -> Result<PathBuf, String> {
    if chosen.is_file() {
        return Ok(chosen.to_path_buf());
    }
    if chosen.is_dir() {
        let script = chosen.join("Publish.command");
        return if script.is_file() {
            Ok(script)
        } else {
            Err(format!(
                "There's no Publish.command in {}. Choose the script itself in Settings → Files.",
                chosen.display()
            ))
        };
    }
    Err(format!(
        "{} isn't there any more. Choose the script again in Settings → Files.",
        chosen.display()
    ))
}

/// The after-ship script, or None when none is chosen.
pub fn script_from_settings() -> Result<Option<PathBuf>, String> {
    let settings = settings::load_settings_from_file()?;
    match settings.site_dir.filter(|d| !d.trim().is_empty()) {
        Some(chosen) => resolve_script(Path::new(&chosen)).map(Some),
        None => Ok(None),
    }
}

fn script_name(script: &Path) -> String {
    script
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "The script".to_string())
}

/// A GUI app inherits a bare PATH; node and npm live in the user's shell
/// paths, so a login shell plus the usual suspects up front.
fn shell_path() -> String {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();
    let inherited = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{inherited}")
}

/// Run the script to completion, from its own folder. Ok(summary) when it
/// succeeded, Err(its last lines) when it failed. A script without the
/// executable bit is handed to zsh rather than refused.
pub fn run_publish(script: &Path) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let name = script_name(script);
    let executable = std::fs::metadata(script)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false);
    let output = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(if executable {
            r#"exec "$RIFF_SCRIPT""#
        } else {
            r#"exec /bin/zsh "$RIFF_SCRIPT""#
        })
        .current_dir(script.parent().unwrap_or(Path::new("/")))
        .env("RIFF_SCRIPT", script)
        .env("PATH", shell_path())
        // Never hang on a credential prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Couldn't start {}: {}", name, e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);
    let lines: Vec<&str> = combined
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if output.status.success() {
        let summary = lines
            .iter()
            .rev()
            .find(|l| l.starts_with('✓') || l.starts_with("Nothing new"))
            .map(|l| l.trim_start_matches('✓').trim().to_string())
            .unwrap_or_else(|| "Done.".to_string());
        Ok(summary)
    } else {
        let tail: Vec<&str> = lines.iter().rev().take(4).rev().copied().collect();
        Err(if tail.is_empty() {
            format!("{} exited with {}", name, output.status)
        } else {
            tail.join(" · ")
        })
    }
}

/// Ask for a publish. Returns immediately; progress arrives as `site-publish`
/// events and, at the end, a macOS notification.
pub fn request_site_publish(app: &AppHandle) -> Result<(), String> {
    let script = script_from_settings()?
        .ok_or("No script chosen to run after something ships. Choose one in Settings → Files.")?;
    {
        let state = app.state::<AppState>();
        let mut publish = state.site_publish.lock().unwrap_or_else(|e| e.into_inner());
        if publish.running {
            publish.pending = true;
            emit(
                app,
                "queued",
                "Another publish is running; yours goes next.",
            );
            return Ok(());
        }
        publish.running = true;
    }

    let handle = app.clone();
    std::thread::spawn(move || loop {
        emit(&handle, "started", "Publishing to the site…");
        match run_publish(&script) {
            Ok(summary) => {
                record_outcome(&handle, None);
                emit(&handle, "done", summary.clone());
                notify(&handle, "Live", &summary);
            }
            Err(detail) => {
                record_outcome(&handle, Some(detail.clone()));
                emit(&handle, "failed", detail.clone());
                notify(&handle, "The site didn't publish", &detail);
            }
        }
        let again = {
            let state = handle.state::<AppState>();
            let mut publish = state.site_publish.lock().unwrap_or_else(|e| e.into_inner());
            if publish.pending {
                publish.pending = false;
                true
            } else {
                publish.running = false;
                false
            }
        };
        if !again {
            break;
        }
    });
    Ok(())
}

#[tauri::command]
pub fn publish_site(app: AppHandle) -> Result<(), String> {
    request_site_publish(&app)
}

/// Why the last publish failed, if it did and none has succeeded since.
/// Each door asks when it opens.
#[tauri::command]
pub fn site_publish_failure(app: AppHandle) -> Option<String> {
    app.state::<AppState>()
        .site_publish
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last_failure
        .clone()
}

#[cfg(test)]
mod tests {
    use super::{resolve_script, run_publish};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("riff-site-{}", unique));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_script(dir: &Path, name: &str, body: &str, executable: bool) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        let mode = if executable { 0o755 } else { 0o644 };
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    /// A folder holding Publish.command, the way Rob's site repo is set up.
    fn fake_site(body: &str) -> PathBuf {
        let dir = temp_dir();
        write_script(&dir, "Publish.command", body, true);
        resolve_script(&dir).unwrap()
    }

    #[test]
    fn a_successful_publish_reports_the_scripts_own_summary() {
        let script = fake_site("#!/bin/zsh\necho ''\necho '  ✓ Published. Live in about a minute → https://conversation.quest'\n");
        let summary = run_publish(&script).unwrap();
        assert_eq!(
            summary,
            "Published. Live in about a minute → https://conversation.quest"
        );
        let _ = fs::remove_dir_all(script.parent().unwrap());
    }

    #[test]
    fn nothing_new_is_still_a_success() {
        let script = fake_site(
            "#!/bin/zsh\necho '  Nothing new to publish — the site already matches the vault.'\n",
        );
        assert!(run_publish(&script).unwrap().starts_with("Nothing new"));
        let _ = fs::remove_dir_all(script.parent().unwrap());
    }

    #[test]
    fn a_failing_publish_surfaces_its_last_lines() {
        let script = fake_site(
            "#!/bin/zsh\necho '  ✗ Sync hit a problem — nothing was published.'\nexit 1\n",
        );
        let err = run_publish(&script).unwrap_err();
        assert!(err.contains("Sync hit a problem"), "got: {err}");
        let _ = fs::remove_dir_all(script.parent().unwrap());
    }

    #[test]
    fn any_chosen_script_runs_from_its_own_folder() {
        let dir = temp_dir();
        let script = write_script(&dir, "after ship.sh", "#!/bin/sh\npwd\n", true);
        assert_eq!(resolve_script(&script).unwrap(), script);
        // No ✓ line: the summary is a plain "Done."
        assert_eq!(run_publish(&script).unwrap(), "Done.");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_script_without_the_executable_bit_still_runs() {
        let dir = temp_dir();
        let script = write_script(&dir, "backup.sh", "echo '✓ Backed up.'\n", false);
        assert_eq!(run_publish(&script).unwrap(), "Backed up.");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_without_publish_command_says_so() {
        let dir = temp_dir();
        let err = resolve_script(&dir).unwrap_err();
        assert!(err.contains("no Publish.command"), "got: {err}");
        assert!(resolve_script(&dir.join("gone"))
            .unwrap_err()
            .contains("isn't there"));
        let _ = fs::remove_dir_all(dir);
    }
}
