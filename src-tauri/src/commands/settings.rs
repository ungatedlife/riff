use super::versioning;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CustomFontEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ThemeColors {
    pub bg: String,
    pub surface: String,
    pub ink: String,
    pub stone: String,
    pub line: String,
    pub accent: String,
    pub accent_light: String,
    pub accent_dark: String,
    #[serde(default)]
    pub highlight: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CustomThemeDefinition {
    pub id: String,
    pub name: String,
    pub is_dark: bool,
    pub colors: ThemeColors,
}

fn default_window_opacity() -> f64 {
    1.0
}

fn default_font_size() -> u32 {
    21
}

fn default_true() -> bool {
    true
}

fn default_text_direction() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiffSettings {
    #[serde(default)]
    pub theme_mode: String,
    /// Absolute path of the drafts directory. None/empty = ~/Documents/Riff.
    #[serde(default)]
    pub drafts_dir: Option<String>,
    /// Absolute path of the vault folder finished riffs publish into.
    #[serde(default)]
    pub vault_dir: Option<String>,
    /// Absolute path of the running note quickies append to.
    /// None = `<vault_dir>/Quickies.md`.
    #[serde(default)]
    pub quickies_file: Option<String>,
    /// Riff is a menu bar app first: no Dock icon unless the user opts in.
    #[serde(default = "default_true")]
    pub hide_dock_icon: bool,
    #[serde(default)]
    pub system_shortcuts: HashMap<String, String>,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    /// Start Riff at login so the hotkeys always have something to summon.
    #[serde(default = "default_true")]
    pub launch_at_login: bool,
    #[serde(default = "default_text_direction")]
    pub text_direction: String,
    #[serde(default)]
    pub hide_tray_icon: bool,
    #[serde(default)]
    pub active_theme: String,
    #[serde(default)]
    pub custom_themes: Vec<CustomThemeDefinition>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default = "default_window_opacity")]
    pub window_opacity: f64,
    #[serde(default)]
    pub custom_fonts: Vec<CustomFontEntry>,
}

impl Default for RiffSettings {
    fn default() -> Self {
        Self {
            theme_mode: String::new(),
            drafts_dir: None,
            vault_dir: None,
            quickies_file: None,
            hide_dock_icon: true,
            system_shortcuts: default_system_shortcuts(),
            font_size: 21,
            launch_at_login: true,
            text_direction: "auto".to_string(),
            hide_tray_icon: false,
            active_theme: String::new(),
            custom_themes: vec![],
            font_family: None,
            window_opacity: 1.0,
            custom_fonts: vec![],
        }
    }
}

pub fn default_system_shortcuts() -> HashMap<String, String> {
    HashMap::from([
        // Hyper (Cmd+Ctrl+Alt+Shift) + R/Q — pairs with a Caps Lock hyper key.
        ("summon".to_string(), "Cmd+Ctrl+Alt+Shift+R".to_string()),
        ("quickie".to_string(), "Cmd+Ctrl+Alt+Shift+Q".to_string()),
        ("search".to_string(), "Cmd+Shift+P".to_string()),
        ("last_note".to_string(), "Cmd+Shift+L".to_string()),
        ("zen_mode".to_string(), "Cmd+Period".to_string()),
    ])
}

/// The only actions registered as OS-level hotkeys: the two capture
/// surfaces. Everything else works only while Riff is active, so Riff never
/// swallows another app's ⌘⇧P.
pub const GLOBAL_ACTIONS: &[&str] = &["summon", "quickie"];

pub fn is_global_action(action: &str) -> bool {
    GLOBAL_ACTIONS.contains(&action)
}

fn normalize_system_shortcuts(shortcuts: &mut HashMap<String, String>) {
    // Settings is ⌘, inside the app and never a hotkey; older files still
    // carry the entry.
    shortcuts.remove("settings");
    let defaults = default_system_shortcuts();
    for (action, default_shortcut) in &defaults {
        shortcuts
            .entry(action.clone())
            .or_insert_with(|| default_shortcut.clone());
    }
}

const BUILTIN_THEME_IDS: &[&str] = &[
    "light",
    "dark",
    "sepia",
    "nord",
    "rose-pine",
    "solarized-light",
    "solarized-dark",
    "dracula",
    "tokyo-night",
];

fn is_legacy_theme_mode(mode: &str) -> bool {
    mode == "system" || mode == "light" || mode == "dark"
}

fn is_valid_active_theme(active_theme: &str, custom_themes: &[CustomThemeDefinition]) -> bool {
    active_theme.is_empty()
        || is_legacy_theme_mode(active_theme)
        || BUILTIN_THEME_IDS.contains(&active_theme)
        || custom_themes.iter().any(|theme| theme.id == active_theme)
}

fn normalize_loaded_settings(mut settings: RiffSettings) -> RiffSettings {
    normalize_system_shortcuts(&mut settings.system_shortcuts);

    // Hiding both icons would leave the hotkeys as the only way in; if one
    // of those ever fails to register, Riff is running and unreachable.
    if settings.hide_dock_icon && settings.hide_tray_icon {
        settings.hide_tray_icon = false;
    }

    if settings.active_theme.is_empty() && is_legacy_theme_mode(&settings.theme_mode) {
        settings.active_theme = settings.theme_mode.clone();
    }

    if !is_valid_active_theme(&settings.active_theme, &settings.custom_themes) {
        settings.active_theme = if is_legacy_theme_mode(&settings.theme_mode) {
            settings.theme_mode.clone()
        } else {
            String::new()
        };
    }

    settings
}

pub(crate) fn get_settings_path() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var("RIFF_TEST_HOME").ok().or_else(|| option_env!("RIFF_TEST_HOME").map(String::from)) {
        let config = PathBuf::from(root);
        if !config.is_absolute() { return Err("RIFF_TEST_HOME must be absolute".to_string()); }
        fs::create_dir_all(&config).map_err(|e| e.to_string())?;
        return Ok(config.join("settings.json"));
    }
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let riff_config = home.join(".riff");
    fs::create_dir_all(&riff_config).map_err(|e| e.to_string())?;
    Ok(riff_config.join("settings.json"))
}

pub(crate) fn load_settings_from_file() -> Result<RiffSettings, String> {
    let path = get_settings_path()?;

    match versioning::load_versioned::<RiffSettings>(&path)? {
        Some(settings) => Ok(normalize_loaded_settings(settings)),
        None => {
            let default_settings = RiffSettings::default();
            save_settings_to_file(&default_settings)?;
            Ok(default_settings)
        }
    }
}

fn save_settings_to_file(settings: &RiffSettings) -> Result<(), String> {
    let path = get_settings_path()?;
    versioning::save_versioned(&path, settings)
}

#[tauri::command]
pub fn get_settings() -> Result<RiffSettings, String> {
    load_settings_from_file()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: RiffSettings) -> Result<bool, String> {
    let settings = normalize_loaded_settings(settings);
    save_settings_to_file(&settings)?;
    apply_launch_at_login(&app, settings.launch_at_login);
    set_launch_item_checked(&app, settings.launch_at_login);
    Ok(true)
}

/// A LaunchAgent points at a fixed executable. Only the installed app should
/// ever register one — a `cargo tauri dev`/`build` binary lives under
/// `target/` and would break at the next rebuild.
fn runs_from_installed_bundle() -> bool {
    std::env::current_exe()
        .map(|exe| !exe.components().any(|c| c.as_os_str() == "target"))
        .unwrap_or(false)
}

pub fn apply_launch_at_login(app: &AppHandle, enable: bool) {
    use tauri_plugin_autostart::ManagerExt;

    if !runs_from_installed_bundle() {
        return;
    }
    let launcher = app.autolaunch();
    let result = if enable {
        launcher.enable()
    } else {
        match launcher.is_enabled() {
            Ok(true) => launcher.disable(),
            _ => Ok(()),
        }
    };
    if let Err(e) = result {
        eprintln!("launch at login: {}", e);
    }
}

fn set_launch_item_checked(app: &AppHandle, checked: bool) {
    let state = app.state::<AppState>();
    let item = state
        .launch_at_login_item
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(item) = item.as_ref() {
        let _ = item.set_checked(checked);
    }
}

/// The menu bar's "Launch at Login" tick: flip the setting and apply it.
pub fn toggle_launch_at_login(app: &AppHandle) {
    let Ok(mut settings) = load_settings_from_file() else {
        return;
    };
    settings.launch_at_login = !settings.launch_at_login;
    if let Err(e) = save_settings_to_file(&settings) {
        eprintln!("launch at login: {}", e);
        return;
    }
    apply_launch_at_login(app, settings.launch_at_login);
    set_launch_item_checked(app, settings.launch_at_login);
    let _ = tauri::Emitter::emit(app, "settings-changed", settings);
}

#[cfg(target_os = "macos")]
pub fn apply_dock_icon_visibility(hide: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplicationActivationPolicy;

    if let Some(mtm) = MainThreadMarker::new() {
        let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
        let policy = if hide {
            NSApplicationActivationPolicy::Accessory
        } else {
            NSApplicationActivationPolicy::Regular
        };
        app.setActivationPolicy(policy);
    }
}

#[tauri::command]
pub fn set_tray_icon_visibility(app: tauri::AppHandle, hide: bool) {
    // Never hide the last remaining way in (see normalize_loaded_settings).
    let dock_hidden = load_settings_from_file()
        .map(|s| s.hide_dock_icon)
        .unwrap_or(true);
    let hide = hide && !dock_hidden;
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_visible(!hide);
    }
}

#[tauri::command]
pub fn set_dock_icon_visibility(hide: bool) {
    #[cfg(target_os = "macos")]
    apply_dock_icon_visibility(hide);
}

fn parse_color_value(color: &str) -> Option<String> {
    let trimmed = color.trim();
    if trimmed.starts_with('#') {
        let hex = trimmed.trim_start_matches('#');
        if hex.len() == 6 {
            if let (Ok(r), Ok(g), Ok(b)) = (
                u8::from_str_radix(&hex[0..2], 16),
                u8::from_str_radix(&hex[2..4], 16),
                u8::from_str_radix(&hex[4..6], 16),
            ) {
                return Some(format!("{} {} {}", r, g, b));
            }
        }
        return None;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() != 3 {
        return None;
    }
    let parsed: Option<Vec<u8>> = parts
        .into_iter()
        .map(|part| part.parse::<u8>().ok())
        .collect();
    parsed.map(|rgb| format!("{} {} {}", rgb[0], rgb[1], rgb[2]))
}

fn parse_theme_colors(colors: ThemeColors) -> Result<ThemeColors, String> {
    let parse = |field: &str, value: &str| {
        parse_color_value(value).ok_or_else(|| format!("Invalid color format for {}", field))
    };

    Ok(ThemeColors {
        bg: parse("bg", &colors.bg)?,
        surface: parse("surface", &colors.surface)?,
        ink: parse("ink", &colors.ink)?,
        stone: parse("stone", &colors.stone)?,
        line: parse("line", &colors.line)?,
        accent: parse("accent", &colors.accent)?,
        accent_light: parse("accent_light", &colors.accent_light)?,
        accent_dark: parse("accent_dark", &colors.accent_dark)?,
        highlight: match colors.highlight {
            Some(h) => Some(parse("highlight", &h)?),
            None => None,
        },
    })
}

fn color_to_hex(rgb: &str) -> String {
    let parts: Vec<u8> = rgb
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    if parts.len() >= 3 {
        format!("#{:02x}{:02x}{:02x}", parts[0], parts[1], parts[2])
    } else {
        rgb.to_string()
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ThemeFile {
    name: String,
    is_dark: bool,
    colors: ThemeColors,
}

#[tauri::command]
pub fn import_theme_file(path: String) -> Result<CustomThemeDefinition, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    let theme_file: ThemeFile = if path.ends_with(".toml") {
        toml::from_str(&content).map_err(|e| format!("Invalid TOML theme file: {}", e))?
    } else {
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON theme file: {}", e))?
    };

    if theme_file.name.trim().is_empty() {
        return Err("Theme file must have a name".to_string());
    }

    let id = format!(
        "imported-{}",
        &uuid::Uuid::new_v4().to_string().replace('-', "")[..12]
    );

    let normalized_colors = parse_theme_colors(theme_file.colors)?;

    Ok(CustomThemeDefinition {
        id,
        name: theme_file.name,
        is_dark: theme_file.is_dark,
        colors: normalized_colors,
    })
}

#[tauri::command]
pub fn export_theme_file(
    path: String,
    name: String,
    is_dark: bool,
    colors: ThemeColors,
) -> Result<(), String> {
    let theme_file = ThemeFile {
        name,
        is_dark,
        colors: ThemeColors {
            bg: color_to_hex(&colors.bg),
            surface: color_to_hex(&colors.surface),
            ink: color_to_hex(&colors.ink),
            stone: color_to_hex(&colors.stone),
            line: color_to_hex(&colors.line),
            accent: color_to_hex(&colors.accent),
            accent_light: color_to_hex(&colors.accent_light),
            accent_dark: color_to_hex(&colors.accent_dark),
            highlight: colors.highlight.as_deref().map(color_to_hex),
        },
    };

    let content = if path.ends_with(".toml") {
        toml::to_string_pretty(&theme_file)
            .map_err(|e| format!("Failed to serialize theme: {}", e))?
    } else {
        serde_json::to_string_pretty(&theme_file)
            .map_err(|e| format!("Failed to serialize theme: {}", e))?
    };

    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_global_action, normalize_loaded_settings, parse_color_value, RiffSettings};

    #[test]
    fn only_the_capture_surfaces_are_global_hotkeys() {
        assert!(is_global_action("summon"));
        assert!(is_global_action("quickie"));
        assert!(!is_global_action("search"));
        assert!(!is_global_action("last_note"));
        assert!(!is_global_action("settings"));
        assert!(!is_global_action("zen_mode"));
    }

    #[test]
    fn stale_settings_hotkey_is_dropped_and_missing_actions_filled() {
        let mut settings = RiffSettings::default();
        settings
            .system_shortcuts
            .insert("settings".to_string(), "Cmd+Shift+Comma".to_string());
        settings.system_shortcuts.remove("zen_mode");

        let normalized = normalize_loaded_settings(settings);
        assert!(!normalized.system_shortcuts.contains_key("settings"));
        assert_eq!(
            normalized
                .system_shortcuts
                .get("zen_mode")
                .map(String::as_str),
            Some("Cmd+Period")
        );
    }

    #[test]
    fn both_icons_can_never_be_hidden_at_once() {
        let settings = RiffSettings { hide_dock_icon: true, hide_tray_icon: true, ..RiffSettings::default() };
        let normalized = normalize_loaded_settings(settings);
        assert!(normalized.hide_dock_icon);
        assert!(!normalized.hide_tray_icon);

        let settings = RiffSettings { hide_dock_icon: false, hide_tray_icon: true, ..RiffSettings::default() };
        assert!(normalize_loaded_settings(settings).hide_tray_icon);
    }

    #[test]
    fn launch_at_login_defaults_on() {
        assert!(RiffSettings::default().launch_at_login);
    }

    #[test]
    fn normalization_falls_back_to_legacy_theme_mode_when_active_theme_is_invalid() {
        let settings = RiffSettings { theme_mode: "dark".to_string(), active_theme: "removed-custom-theme".to_string(), ..RiffSettings::default() };

        let normalized = normalize_loaded_settings(settings);
        assert_eq!(normalized.active_theme, "dark");
    }

    #[test]
    fn parse_color_value_rejects_invalid_strings() {
        assert_eq!(parse_color_value("#112233"), Some("17 34 51".to_string()));
        assert_eq!(parse_color_value("10 20 30"), Some("10 20 30".to_string()));
        assert_eq!(parse_color_value("not-a-color"), None);
    }
}
