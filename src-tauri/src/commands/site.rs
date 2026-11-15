/// The vault → site publish, run from Riff. `Publish.command` in the site
/// repo pulls, syncs the vault into the repo, commits, and pushes; the site
/// is live about a minute later. Riff runs it in the background after
/// anything ships, one run at a time — a spark that lands mid-publish
/// queues one more run rather than racing the first.
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

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

pub fn site_dir_from_settings() -> Result<PathBuf, String> {
    let settings = settings::load_settings_from_file()?;
    let dir = settings
        .site_dir
        .filter(|d| !d.trim().is_empty())
        .ok_or("No site folder chosen. Pick the website repo in Settings → Files.")?;
    let path = PathBuf::from(dir);
    if !path.join("Publish.command").is_file() {
        return Err(format!(
            "No Publish.command in {} — is that the website repo?",
            path.display()
        ));
    }
    Ok(path)
}

/// A GUI app inherits a bare PATH; node and npm live in the user's shell
/// paths, so a login shell plus the usual suspects up front.
fn shell_path() -> String {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();
    let inherited = std::env::var("PATH").unwrap_or_default();
    format!(
        "{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{inherited}"
    )
}

/// Run the publish to completion. Ok(summary) when the site accepted the
/// publish (or had nothing new), Err(last lines) when the script failed.
pub fn run_publish(site_dir: &Path) -> Result<String, String> {
    let output = Command::new("/bin/zsh")
        .arg("-lc")
        .arg("exec ./Publish.command")
        .current_dir(site_dir)
        .env("PATH", shell_path())
        // Never hang on a credential prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Couldn't start Publish.command: {}", e))?;
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
            .unwrap_or_else(|| "Published.".to_string());
        Ok(summary)
    } else {
        let tail: Vec<&str> = lines.iter().rev().take(4).rev().copied().collect();
        Err(if tail.is_empty() {
            format!("Publish.command exited with {}", output.status)
        } else {
            tail.join(" · ")
        })
    }
}

/// Ask for a publish. Returns immediately; progress arrives as `site-publish`
/// events and, at the end, a macOS notification.
pub fn request_site_publish(app: &AppHandle) -> Result<(), String> {
    let site_dir = site_dir_from_settings()?;
    {
        let state = app.state::<AppState>();
        let mut publish = state
            .site_publish
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if publish.running {
            publish.pending = true;
            emit(app, "queued", "Another publish is running; yours goes next.");
            return Ok(());
        }
        publish.running = true;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            emit(&handle, "started", "Publishing to the site…");
            match run_publish(&site_dir) {
                Ok(summary) => {
                    emit(&handle, "done", summary.clone());
                    notify(&handle, "Live", &summary);
                }
                Err(detail) => {
                    emit(&handle, "failed", detail.clone());
                    notify(&handle, "The site didn't publish", &detail);
                }
            }
            let again = {
                let state = handle.state::<AppState>();
                let mut publish = state
                    .site_publish
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
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
        }
    });
    Ok(())
}

#[tauri::command]
pub fn publish_site(app: AppHandle) -> Result<(), String> {
    request_site_publish(&app)
}

#[cfg(test)]
mod tests {
    use super::run_publish;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fake_site(script: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("riff-site-{}", unique));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Publish.command");
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    #[test]
    fn a_successful_publish_reports_the_scripts_own_summary() {
        let dir = fake_site("#!/bin/zsh\necho ''\necho '  ✓ Published. Live in about a minute → https://conversation.quest'\n");
        let summary = run_publish(&dir).unwrap();
        assert_eq!(summary, "Published. Live in about a minute → https://conversation.quest");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn nothing_new_is_still_a_success() {
        let dir = fake_site("#!/bin/zsh\necho '  Nothing new to publish — the site already matches the vault.'\n");
        assert!(run_publish(&dir).unwrap().starts_with("Nothing new"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failing_publish_surfaces_its_last_lines() {
        let dir = fake_site("#!/bin/zsh\necho '  ✗ Sync hit a problem — nothing was published.'\nexit 1\n");
        let err = run_publish(&dir).unwrap_err();
        assert!(err.contains("Sync hit a problem"), "got: {err}");
        let _ = fs::remove_dir_all(dir);
    }
}
