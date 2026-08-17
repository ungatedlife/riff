use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;

const CURRENT_VERSION: u32 = 3;

#[derive(Debug, Serialize, Deserialize)]
struct VersionedStore {
    version: u32,
    data: Value,
}

/// Load a versioned JSON file. Handles both legacy (unversioned) and versioned formats.
/// Returns the deserialized data after applying any necessary migrations.
pub fn load_versioned<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    // Check if it's a versioned store (has "version" and "data" keys)
    if let Some(obj) = value.as_object() {
        if obj.contains_key("version") && obj.contains_key("data") {
            let store: VersionedStore = serde_json::from_value(value).map_err(|e| e.to_string())?;
            let migrated = migrate(store.version, store.data)?;
            let result: T = serde_json::from_value(migrated).map_err(|e| e.to_string())?;
            return Ok(Some(result));
        }
    }

    // Legacy unversioned format — treat as version 0, migrate to current
    let migrated = migrate(0, value)?;
    let result: T = serde_json::from_value(migrated).map_err(|e| e.to_string())?;
    Ok(Some(result))
}

/// Save data in versioned format.
pub fn save_versioned<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    let data_value = serde_json::to_value(data).map_err(|e| e.to_string())?;
    let store = VersionedStore {
        version: CURRENT_VERSION,
        data: data_value,
    };
    let content = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;

    // Atomic write via temp file
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, path).map_err(|e| e.to_string())
}

/// Apply migrations from `from_version` to CURRENT_VERSION.
/// Version 0 → 1 is a no-op (data format unchanged, just wrapping in envelope).
fn migrate(from_version: u32, data: Value) -> Result<Value, String> {
    let mut current = data;
    let mut version = from_version;

    while version < CURRENT_VERSION {
        current = match version {
            0 => migrate_v0_to_v1(current)?,
            1 => migrate_v1_to_v2(current)?,
            2 => migrate_v2_to_v3(current)?,
            _ => return Err(format!("Unknown migration version: {}", version)),
        };
        version += 1;
    }

    Ok(current)
}

/// v0 → v1: No structural changes, just wrapping in versioned envelope.
fn migrate_v0_to_v1(data: Value) -> Result<Value, String> {
    Ok(data)
}

/// v1 → v2: The defaults changed — menu-bar-only app and 20px editor text
/// (matching the vault's typography). Values still sitting at the old defaults
/// follow along; anything the user changed away from the old defaults is left
/// untouched. Stores without these keys (cursor positions, etc.) pass through
/// unchanged.
fn migrate_v1_to_v2(mut data: Value) -> Result<Value, String> {
    if let Some(obj) = data.as_object_mut() {
        if obj.get("font_size").and_then(Value::as_u64) == Some(16) {
            obj.insert("font_size".to_string(), Value::from(20));
        }
        if obj.get("hide_dock_icon").and_then(Value::as_bool) == Some(false) {
            obj.insert("hide_dock_icon".to_string(), Value::from(true));
        }
    }
    Ok(data)
}

/// v2 → v3: default text grew one step, 20px → 21px. 18 only ever existed
/// as a short-lived interim default, so both old defaults move to 21;
/// any other size is a user choice and stays.
fn migrate_v2_to_v3(mut data: Value) -> Result<Value, String> {
    if let Some(obj) = data.as_object_mut() {
        let size = obj.get("font_size").and_then(Value::as_u64);
        if size == Some(20) || size == Some(18) {
            obj.insert("font_size".to_string(), Value::from(21));
        }
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn v1_to_v2_leaves_user_chosen_values_alone() {
        let data = json!({ "font_size": 22, "hide_dock_icon": true });
        let migrated = migrate(1, data).unwrap();
        assert_eq!(migrated["font_size"], 22);
        assert_eq!(migrated["hide_dock_icon"], true);
    }

    #[test]
    fn v1_to_v2_ignores_stores_without_settings_keys() {
        let data = json!({ "some/path.md": { "head": 4, "anchor": 4 } });
        let migrated = migrate(1, data.clone()).unwrap();
        assert_eq!(migrated, data);
    }

    #[test]
    fn v2_to_v3_bumps_old_default_text_sizes_to_21() {
        let migrated = migrate(2, json!({ "font_size": 20 })).unwrap();
        assert_eq!(migrated["font_size"], 21);
        let interim = migrate(2, json!({ "font_size": 18 })).unwrap();
        assert_eq!(interim["font_size"], 21);
    }

    #[test]
    fn v2_to_v3_leaves_user_chosen_sizes_alone() {
        let migrated = migrate(2, json!({ "font_size": 24 })).unwrap();
        assert_eq!(migrated["font_size"], 24);
    }

    #[test]
    fn v1_files_chain_all_the_way_to_current_defaults() {
        let data = json!({ "font_size": 16, "hide_dock_icon": false });
        let migrated = migrate(1, data).unwrap();
        assert_eq!(migrated["font_size"], 21);
        assert_eq!(migrated["hide_dock_icon"], true);
    }
}
