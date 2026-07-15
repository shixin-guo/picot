#![allow(dead_code)]

use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingScope {
    CurrentSession,
    Project,
    Global,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingSource {
    Project,
    Global,
    PiDefault,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EffectiveSetting {
    pub value: Value,
    pub source: SettingSource,
}

pub struct SettingsStore {
    global_path: PathBuf,
    project_path: PathBuf,
    project_trusted: bool,
}

impl SettingsStore {
    pub fn new(global_path: PathBuf, project_path: PathBuf, project_trusted: bool) -> Self {
        Self {
            global_path,
            project_path,
            project_trusted,
        }
    }

    pub fn effective(&self, key: &str, pi_default: Value) -> Result<EffectiveSetting, String> {
        if self.project_trusted {
            if let Some(value) = read_object(&self.project_path)?.get(key) {
                return Ok(EffectiveSetting {
                    value: value.clone(),
                    source: SettingSource::Project,
                });
            }
        }
        if let Some(value) = read_object(&self.global_path)?.get(key) {
            return Ok(EffectiveSetting {
                value: value.clone(),
                source: SettingSource::Global,
            });
        }
        Ok(EffectiveSetting {
            value: pi_default,
            source: SettingSource::PiDefault,
        })
    }

    pub fn merge(&self, scope: SettingScope, patch: &Value) -> Result<(), String> {
        let path = self.path_for_write(scope)?;
        let patch = patch
            .as_object()
            .ok_or_else(|| "Settings patch must be an object".to_string())?;
        let mut settings = read_object(path)?;
        for (key, value) in patch {
            settings.insert(key.clone(), value.clone());
        }
        atomic_write_object(path, &settings)
    }

    pub fn remove_override(&self, scope: SettingScope, key: &str) -> Result<(), String> {
        let path = self.path_for_write(scope)?;
        let mut settings = read_object(path)?;
        settings.remove(key);
        atomic_write_object(path, &settings)
    }

    fn path_for_write(&self, scope: SettingScope) -> Result<&Path, String> {
        match scope {
            SettingScope::CurrentSession => {
                Err("Current Session settings must use native Pi RPC".into())
            }
            SettingScope::Project if !self.project_trusted => {
                Err("Project settings cannot be changed until the workspace is trusted".into())
            }
            SettingScope::Project => Ok(&self.project_path),
            SettingScope::Global => Ok(&self.global_path),
        }
    }
}

fn read_object(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Cannot read Pi settings {}: {error}", path.display()))?;
    serde_json::from_slice::<Value>(&bytes)
        .map_err(|error| format!("Invalid Pi settings JSON {}: {error}", path.display()))?
        .as_object()
        .cloned()
        .ok_or_else(|| format!("Pi settings must be a JSON object: {}", path.display()))
}

fn atomic_write_object(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Settings path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Cannot create settings directory {}: {error}",
            parent.display()
        )
    })?;
    let temporary = parent.join(format!(".picot-settings-{}.tmp", Uuid::new_v4().simple()));
    let encoded = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Cannot encode Pi settings: {error}"))?;
    let write_result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Cannot create temporary settings file: {error}"))?;
        file.write_all(&encoded)
            .map_err(|error| format!("Cannot write temporary settings file: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("Cannot finish temporary settings file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync temporary settings file: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| {
            format!(
                "Cannot atomically replace settings {}: {error}",
                path.display()
            )
        })
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(test)]
mod tests {
    use super::{SettingScope, SettingSource, SettingsStore};
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn paths() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("picot-settings-{nonce}"));
        let global = root.join("global/settings.json");
        let project = root.join("workspace/.pi/settings.json");
        fs::create_dir_all(global.parent().unwrap()).unwrap();
        fs::create_dir_all(project.parent().unwrap()).unwrap();
        (root, global, project)
    }

    #[test]
    fn resolves_effective_values_and_preserves_unknown_keys_on_atomic_merge() {
        let (root, global, project) = paths();
        fs::write(
            &global,
            serde_json::to_vec(&json!({ "thinkingLevel": "low", "unknownGlobal": 7 })).unwrap(),
        )
        .unwrap();
        fs::write(
            &project,
            serde_json::to_vec(&json!({ "thinkingLevel": "high", "unknownProject": true }))
                .unwrap(),
        )
        .unwrap();
        let store = SettingsStore::new(global.clone(), project.clone(), true);
        let effective = store.effective("thinkingLevel", json!("medium")).unwrap();
        assert_eq!(effective.value, json!("high"));
        assert_eq!(effective.source, SettingSource::Project);

        store
            .merge(SettingScope::Project, &json!({ "thinkingLevel": "xhigh" }))
            .unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(project).unwrap()).unwrap();
        assert_eq!(written["thinkingLevel"], "xhigh");
        assert_eq!(written["unknownProject"], true);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prevents_project_writes_when_untrusted_and_supports_override_removal() {
        let (root, global, project) = paths();
        fs::write(&global, "{\"autoRetry\":true}").unwrap();
        fs::write(&project, "{\"autoRetry\":false}").unwrap();
        let untrusted = SettingsStore::new(global.clone(), project.clone(), false);
        assert!(untrusted
            .merge(SettingScope::Project, &json!({ "autoRetry": true }))
            .is_err());

        let trusted = SettingsStore::new(global, project, true);
        trusted
            .remove_override(SettingScope::Project, "autoRetry")
            .unwrap();
        let effective = trusted.effective("autoRetry", json!(false)).unwrap();
        assert_eq!(effective.value, json!(true));
        assert_eq!(effective.source, SettingSource::Global);
        fs::remove_dir_all(root).unwrap();
    }
}
