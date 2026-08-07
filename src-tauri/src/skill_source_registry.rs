// ABOUTME: Owns short-lived opaque handles for authenticated local skill sources.
// ABOUTME: Binds each handle to its window, owner, workspace, port, and generation.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::rngs::OsRng;
use rand::RngCore;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::window_owner::OwnerId;

#[allow(dead_code)]
pub const SKILL_SOURCE_TTL: Duration = Duration::from_secs(10 * 60);
#[allow(dead_code)]
pub const MAX_SKILL_SOURCES_PER_OWNER: usize = 8;
#[allow(dead_code)]
const SOURCE_ID_BYTES: usize = 32;
const INVALID_SOURCE: &str = "invalid or expired skill source";

type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillSourceBinding {
    pub source_id: String,
    pub canonical_path: PathBuf,
    pub owner_id: OwnerId,
    pub window_label: String,
    pub workspace_root: PathBuf,
    pub workspace_port: u16,
    pub workspace_generation: u64,
}

#[derive(Clone)]
pub struct SkillSourceRegistry {
    inner: Arc<Mutex<RegistryState>>,
    clock: Clock,
}

struct RegistryState {
    entries: HashMap<String, Entry>,
}

struct Entry {
    binding: SkillSourceBinding,
    expires_at: Instant,
    #[allow(dead_code)]
    issued_at: Instant,
}

impl Default for SkillSourceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillSourceRegistry {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(Instant::now))
    }

    pub fn with_clock(clock: Clock) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryState {
                entries: HashMap::new(),
            })),
            clock,
        }
    }

    #[allow(dead_code)]
    pub fn issue(
        &self,
        owner_id: OwnerId,
        window_label: String,
        workspace_root: PathBuf,
        workspace_port: u16,
        workspace_generation: u64,
        canonical_path: PathBuf,
    ) -> Result<String, String> {
        let canonical_workspace = canonical_dir(&workspace_root)?;
        let canonical_source = canonical_dir(&canonical_path)?;
        let now = (self.clock)();
        let mut state = self.inner.lock().map_err(|_| INVALID_SOURCE.to_string())?;
        state.entries.retain(|_, entry| entry.expires_at > now);
        state.entries.retain(|_, entry| {
            !(entry.binding.owner_id == owner_id && entry.binding.window_label == window_label)
        });
        let owner_count = state
            .entries
            .values()
            .filter(|entry| entry.binding.owner_id == owner_id)
            .count();
        if owner_count >= MAX_SKILL_SOURCES_PER_OWNER {
            let oldest = state
                .entries
                .iter()
                .filter(|(_, entry)| entry.binding.owner_id == owner_id)
                .min_by_key(|(_, entry)| entry.issued_at)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                state.entries.remove(&id);
            }
        }

        let mut bytes = [0u8; SOURCE_ID_BYTES];
        OsRng.fill_bytes(&mut bytes);
        let source_id = URL_SAFE_NO_PAD.encode(bytes);
        state.entries.insert(
            source_id.clone(),
            Entry {
                binding: SkillSourceBinding {
                    source_id: source_id.clone(),
                    canonical_path: canonical_source,
                    owner_id,
                    window_label,
                    workspace_root: canonical_workspace,
                    workspace_port,
                    workspace_generation,
                },
                expires_at: now + SKILL_SOURCE_TTL,
                issued_at: now,
            },
        );
        Ok(source_id)
    }

    #[allow(dead_code)]
    pub fn resolve(
        &self,
        source_id: &str,
        owner_id: &OwnerId,
        window_label: &str,
        workspace_root: &Path,
        workspace_generation: u64,
    ) -> Result<SkillSourceBinding, String> {
        let canonical_workspace =
            canonical_dir(workspace_root).map_err(|_| INVALID_SOURCE.to_string())?;
        let now = (self.clock)();
        let mut state = self.inner.lock().map_err(|_| INVALID_SOURCE.to_string())?;
        state.entries.retain(|_, entry| entry.expires_at > now);
        let entry = state
            .entries
            .get(source_id)
            .ok_or_else(|| INVALID_SOURCE.to_string())?;
        if entry.binding.owner_id != *owner_id
            || entry.binding.window_label != window_label
            || entry.binding.workspace_root != canonical_workspace
            || entry.binding.workspace_generation != workspace_generation
        {
            return Err(INVALID_SOURCE.to_string());
        }
        Ok(entry.binding.clone())
    }

    #[allow(dead_code)]
    pub fn consume(
        &self,
        source_id: &str,
        owner_id: &OwnerId,
        workspace_generation: u64,
    ) -> Result<(), String> {
        let now = (self.clock)();
        let mut state = self.inner.lock().map_err(|_| INVALID_SOURCE.to_string())?;
        state.entries.retain(|_, entry| entry.expires_at > now);
        let entry = state
            .entries
            .get(source_id)
            .ok_or_else(|| INVALID_SOURCE.to_string())?;
        if entry.binding.owner_id != *owner_id
            || entry.binding.workspace_generation != workspace_generation
        {
            return Err(INVALID_SOURCE.to_string());
        }
        state.entries.remove(source_id);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn revoke_owner(&self, owner_id: &OwnerId) {
        if let Ok(mut state) = self.inner.lock() {
            state
                .entries
                .retain(|_, entry| entry.binding.owner_id != *owner_id);
        }
    }

    #[allow(dead_code)]
    pub fn revoke_workspace(&self, owner_id: &OwnerId, generation: u64) {
        if let Ok(mut state) = self.inner.lock() {
            state.entries.retain(|_, entry| {
                !(entry.binding.owner_id == *owner_id
                    && entry.binding.workspace_generation == generation)
            });
        }
    }

    #[allow(dead_code)]
    pub fn revoke_port(&self, workspace_port: u16) {
        if let Ok(mut state) = self.inner.lock() {
            state
                .entries
                .retain(|_, entry| entry.binding.workspace_port != workspace_port);
        }
    }
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(path).map_err(|_| INVALID_SOURCE.to_string())?;
    if !metadata.is_dir() {
        return Err(INVALID_SOURCE.to_string());
    }
    std::fs::canonicalize(path).map_err(|_| INVALID_SOURCE.to_string())
}

/// Placeholder: scans a local skill source directory for candidates.
/// The full implementation delegates to the embedded Pi extension layer.
#[allow(dead_code)]
pub fn scan_source_static(
    _source_id: &str,
    _install_secret: &str,
) -> Result<serde_json::Value, String> {
    Err("skill source scanning is not yet wired to the native host".into())
}

/// Placeholder: installs skill links into Pi's settings.json.
#[allow(dead_code)]
pub fn install_links_static(
    _source_id: &str,
    _scope: &str,
    _scan_revision: &str,
    _selection: &[serde_json::Value],
    _install_secret: &str,
) -> Result<serde_json::Value, String> {
    Err("skill link installation is not yet wired to the native host".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tempfile::tempdir;

    fn clock() -> (Arc<AtomicU64>, Clock) {
        let seconds = Arc::new(AtomicU64::new(100));
        let value = Arc::clone(&seconds);
        let clock: Clock =
            Arc::new(move || Instant::now() + Duration::from_secs(value.load(Ordering::SeqCst)));
        (seconds, clock)
    }

    fn owner(value: &str) -> OwnerId {
        OwnerId::from_string(value.to_string())
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let source = temp.path().join("source");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&source).unwrap();
        (temp, workspace, source)
    }

    #[test]
    fn issues_random_url_safe_handle_and_resolves_binding() {
        let (_temp, workspace, source) = fixture();
        let registry = SkillSourceRegistry::new();
        let id = registry
            .issue(
                owner("owner"),
                "main".into(),
                workspace.clone(),
                4100,
                7,
                source.clone(),
            )
            .unwrap();
        assert_eq!(id.len(), 43);
        assert!(id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        let binding = registry
            .resolve(&id, &owner("owner"), "main", &workspace, 7)
            .unwrap();
        assert_eq!(binding.canonical_path, fs::canonicalize(source).unwrap());
        assert_eq!(binding.workspace_port, 4100);
    }

    #[test]
    fn rejects_non_directory_and_wrong_bindings_without_path_details() {
        let (temp, workspace, source) = fixture();
        let file = temp.path().join("file");
        fs::write(&file, "x").unwrap();
        let registry = SkillSourceRegistry::new();
        let error = registry
            .issue(
                owner("owner"),
                "main".into(),
                workspace.clone(),
                4100,
                7,
                file,
            )
            .unwrap_err();
        assert_eq!(error, INVALID_SOURCE);
        let id = registry
            .issue(
                owner("owner"),
                "main".into(),
                workspace.clone(),
                4100,
                7,
                source,
            )
            .unwrap();
        for (owner_name, window, generation) in [
            ("other", "main", 7),
            ("owner", "other", 7),
            ("owner", "main", 8),
        ] {
            assert_eq!(
                registry
                    .resolve(&id, &owner(owner_name), window, &workspace, generation)
                    .unwrap_err(),
                INVALID_SOURCE
            );
        }
    }

    #[test]
    fn replacement_and_consume_are_single_use() {
        let (_temp, workspace, source) = fixture();
        let registry = SkillSourceRegistry::new();
        let first = registry
            .issue(
                owner("owner"),
                "main".into(),
                workspace.clone(),
                1,
                0,
                source.clone(),
            )
            .unwrap();
        let second = registry
            .issue(
                owner("owner"),
                "main".into(),
                workspace.clone(),
                1,
                0,
                source,
            )
            .unwrap();
        assert_eq!(
            registry
                .resolve(&first, &owner("owner"), "main", &workspace, 0)
                .unwrap_err(),
            INVALID_SOURCE
        );
        registry.consume(&second, &owner("owner"), 0).unwrap();
        assert_eq!(
            registry.consume(&second, &owner("owner"), 0).unwrap_err(),
            INVALID_SOURCE
        );
    }

    #[test]
    fn expiry_uses_injected_clock() {
        let (_temp, workspace, source) = fixture();
        let (seconds, clock) = clock();
        let registry = SkillSourceRegistry::with_clock(clock);
        let id = registry
            .issue(
                owner("owner"),
                "main".into(),
                workspace.clone(),
                1,
                0,
                source,
            )
            .unwrap();
        seconds.fetch_add(SKILL_SOURCE_TTL.as_secs() + 1, Ordering::SeqCst);
        assert_eq!(
            registry
                .resolve(&id, &owner("owner"), "main", &workspace, 0)
                .unwrap_err(),
            INVALID_SOURCE
        );
    }

    #[test]
    fn revocation_is_idempotent_and_scoped() {
        let (_temp, workspace, source) = fixture();
        let registry = SkillSourceRegistry::new();
        let owner_handle = registry
            .issue(
                owner("owner"),
                "main".into(),
                workspace.clone(),
                1,
                1,
                source.clone(),
            )
            .unwrap();
        let other = registry
            .issue(
                owner("other"),
                "main".into(),
                workspace.clone(),
                2,
                2,
                source,
            )
            .unwrap();
        registry.revoke_workspace(&owner("owner"), 1);
        registry.revoke_workspace(&owner("owner"), 1);
        assert_eq!(
            registry
                .resolve(&owner_handle, &owner("owner"), "main", &workspace, 1)
                .unwrap_err(),
            INVALID_SOURCE
        );
        assert!(registry
            .resolve(&other, &owner("other"), "main", &workspace, 2)
            .is_ok());
        registry.revoke_port(2);
        registry.revoke_port(2);
        assert_eq!(
            registry
                .resolve(&other, &owner("other"), "main", &workspace, 2)
                .unwrap_err(),
            INVALID_SOURCE
        );
    }

    #[test]
    fn caps_live_handles_per_owner_by_evicting_oldest() {
        let (_temp, workspace, source) = fixture();
        let registry = SkillSourceRegistry::new();
        let mut ids = Vec::new();
        for window in 0..=MAX_SKILL_SOURCES_PER_OWNER {
            ids.push(
                registry
                    .issue(
                        owner("owner"),
                        window.to_string(),
                        workspace.clone(),
                        window as u16,
                        0,
                        source.clone(),
                    )
                    .unwrap(),
            );
        }
        assert_eq!(
            registry
                .resolve(&ids[0], &owner("owner"), "0", &workspace, 0)
                .unwrap_err(),
            INVALID_SOURCE
        );
        assert!(registry
            .resolve(&ids[1], &owner("owner"), "1", &workspace, 0)
            .is_ok());
    }
}
