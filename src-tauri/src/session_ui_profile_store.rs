// ABOUTME: Persists per-session model/thinking display profiles in host-owned storage.
// ABOUTME: Validates versioned records and prunes profiles for deleted sessions.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
const MAX_PROVIDER_LENGTH: usize = 128;
const MAX_MODEL_ID_LENGTH: usize = 256;
const MAX_SESSION_PATH_LENGTH: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionUiProfile {
    pub provider: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "thinkingLevel")]
    pub thinking_level: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ProfileDocument {
    schema_version: u32,
    #[serde(default)]
    profiles: BTreeMap<String, StoredProfile>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredProfile {
    profile: SessionUiProfile,
    updated_at: u64,
}

pub struct SessionUiProfileStore {
    path: PathBuf,
    document: Mutex<ProfileDocument>,
}

impl SessionUiProfileStore {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create session UI profile directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let document = match fs::read_to_string(&path) {
            Ok(contents) => decode_document(&contents)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ProfileDocument {
                schema_version: SCHEMA_VERSION,
                profiles: BTreeMap::new(),
            },
            Err(error) => {
                return Err(format!(
                    "Cannot read session UI profiles {}: {error}",
                    path.display()
                ));
            }
        };
        restrict_permissions(&path)?;
        Ok(Self {
            path,
            document: Mutex::new(document),
        })
    }

    pub fn load(&self, session_path: &str) -> Result<Option<SessionUiProfile>, String> {
        let key = normalize_session_path(session_path)?;
        let mut document = self.document.lock().map_err(lock_error)?;
        let changed = prune_missing(&mut document.profiles);
        let profile = document
            .profiles
            .get(&key)
            .map(|stored| stored.profile.clone());
        if changed {
            self.write_locked(&document)?;
        }
        Ok(profile)
    }

    pub fn save(
        &self,
        session_path: &str,
        provider: &str,
        model_id: &str,
        thinking_level: &str,
    ) -> Result<SessionUiProfile, String> {
        let key = normalize_session_path(session_path)?;
        let profile = normalize_profile(provider, model_id, thinking_level)?;
        let mut document = self.document.lock().map_err(lock_error)?;
        let _ = prune_missing(&mut document.profiles);
        document.profiles.insert(
            key,
            StoredProfile {
                profile: profile.clone(),
                updated_at: unix_timestamp(),
            },
        );
        self.write_locked(&document)?;
        Ok(profile)
    }

    fn write_locked(&self, document: &ProfileDocument) -> Result<(), String> {
        let temporary = self
            .path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!(
                ".session-ui-profiles-{}.tmp",
                Uuid::new_v4().simple()
            ));
        let encoded = serde_json::to_vec_pretty(document)
            .map_err(|error| format!("Cannot encode session UI profiles: {error}"))?;
        let result = (|| {
            fs::write(&temporary, &encoded)
                .map_err(|error| format!("Cannot write temporary session UI profiles: {error}"))?;
            fs::rename(&temporary, &self.path).map_err(|error| {
                format!(
                    "Cannot atomically replace session UI profiles {}: {error}",
                    self.path.display()
                )
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        restrict_permissions(&self.path)?;
        result
    }
}

fn decode_document(contents: &str) -> Result<ProfileDocument, String> {
    let document: ProfileDocument = serde_json::from_str(contents)
        .map_err(|error| format!("Invalid session UI profile JSON: {error}"))?;
    if document.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "Unsupported session UI profile schema version {}",
            document.schema_version
        ));
    }
    Ok(document)
}

pub fn validate_session_path(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_SESSION_PATH_LENGTH {
        return Err("Invalid session UI profile session path".to_string());
    }
    Ok(())
}

fn normalize_session_path(value: &str) -> Result<String, String> {
    validate_session_path(value)?;
    Ok(value.trim().to_string())
}

fn normalize_profile(
    provider: &str,
    model_id: &str,
    thinking_level: &str,
) -> Result<SessionUiProfile, String> {
    let provider = provider.trim();
    let model_id = model_id.trim();
    if provider.is_empty() || provider.len() > MAX_PROVIDER_LENGTH {
        return Err("Invalid session UI profile provider".to_string());
    }
    if model_id.is_empty() || model_id.len() > MAX_MODEL_ID_LENGTH {
        return Err("Invalid session UI profile model".to_string());
    }
    if !matches!(
        thinking_level,
        "off" | "minimal" | "low" | "medium" | "high"
    ) {
        return Err("Invalid session UI profile thinking level".to_string());
    }
    Ok(SessionUiProfile {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        thinking_level: thinking_level.to_string(),
    })
}

fn prune_missing(profiles: &mut BTreeMap<String, StoredProfile>) -> bool {
    let before = profiles.len();
    profiles.retain(|path, _| match fs::metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    });
    profiles.len() != before
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn lock_error<T>(_error: std::sync::PoisonError<T>) -> String {
    "Session UI profile store lock poisoned".to_string()
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if !path.exists() {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Cannot restrict session UI profile permissions: {error}"))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{SessionUiProfileStore, SCHEMA_VERSION};
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempdir().unwrap();
        let session = dir.path().join("session.jsonl");
        fs::write(&session, "{}\n").unwrap();
        let profiles = dir.path().join("profiles.json");
        (dir, profiles, session)
    }

    #[test]
    fn saves_and_loads_versioned_profile_without_pi_defaults() {
        let (_dir, path, session) = setup();
        let store = SessionUiProfileStore::open(path.clone()).unwrap();
        let saved = store
            .save(
                session.to_str().unwrap(),
                "anthropic",
                "claude-sonnet",
                "off",
            )
            .unwrap();
        assert_eq!(store.load(session.to_str().unwrap()).unwrap(), Some(saved));
        let document: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(document["schema_version"], SCHEMA_VERSION);
        assert_eq!(
            document["profiles"][session.to_str().unwrap()]["profile"]["modelId"],
            "claude-sonnet"
        );
        assert!(document["profiles"][session.to_str().unwrap()]["updated_at"].is_number());
    }

    #[test]
    fn rejects_invalid_profile_values() {
        let (_dir, path, session) = setup();
        let store = SessionUiProfileStore::open(path).unwrap();
        assert!(store
            .save(session.to_str().unwrap(), "", "model", "off")
            .is_err());
        assert!(store
            .save(session.to_str().unwrap(), "p", "m", "xhigh")
            .is_err());
    }

    #[test]
    fn prunes_profiles_for_deleted_sessions_on_next_access() {
        let (dir, path, session) = setup();
        let store = SessionUiProfileStore::open(path.clone()).unwrap();
        store
            .save(session.to_str().unwrap(), "openai", "gpt-5", "medium")
            .unwrap();
        fs::remove_file(&session).unwrap();
        assert_eq!(store.load(session.to_str().unwrap()).unwrap(), None);
        let document: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(document["profiles"], json!({}));
        drop(dir);
    }

    #[test]
    fn rejects_newer_schema_documents() {
        let (_dir, path, _session) = setup();
        fs::write(
            &path,
            serde_json::to_vec(&json!({"schema_version": SCHEMA_VERSION + 1, "profiles": {}}))
                .unwrap(),
        )
        .unwrap();
        assert!(SessionUiProfileStore::open(path).is_err());
    }
}
