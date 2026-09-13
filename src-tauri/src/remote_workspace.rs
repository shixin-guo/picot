//! Prepares the local anchor directory that represents a remote workspace.
//!
//! A remote workspace has no local checkout: `extensions/ssh-remote.ts` maps
//! every path under the session's cwd onto `sshRemote.remotePath` on the other
//! machine. The cwd still has to exist locally, though — it is what pi is
//! launched in and what the workspace registry keys on. So "connect to a remote
//! host" creates a small, stable anchor directory under `~/.picot/remotes/` and
//! writes the binding into its `.pi/settings.json`; the user never has to
//! hand-pick a throwaway local folder first.

use crate::settings_store::{SettingScope, SettingsStore};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// What the connect dialog sends. Either `host_ref` (an alias into the global
/// `sshHosts` registry) or an inline `host` must be present.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceRequest {
    #[serde(default)]
    pub host_ref: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub identity_file: String,
    #[serde(default)]
    pub remote_path: String,
}

impl RemoteWorkspaceRequest {
    fn trimmed(&self) -> Self {
        Self {
            host_ref: self.host_ref.trim().to_string(),
            host: self.host.trim().to_string(),
            port: self.port,
            user: self.user.trim().to_string(),
            identity_file: self.identity_file.trim().to_string(),
            remote_path: self.remote_path.trim().to_string(),
        }
    }

    /// The `sshRemote` block for the anchor's `.pi/settings.json`. An aliased
    /// binding stores no credentials: the global registry owns them.
    fn binding(&self) -> Value {
        let mut binding = Map::new();
        binding.insert("enabled".into(), json!(true));
        if self.host_ref.is_empty() {
            binding.insert("host".into(), json!(self.host));
            if let Some(port) = self.port {
                binding.insert("port".into(), json!(port));
            }
            if !self.user.is_empty() {
                binding.insert("user".into(), json!(self.user));
            }
            if !self.identity_file.is_empty() {
                binding.insert("identityFile".into(), json!(self.identity_file));
            }
        } else {
            binding.insert("hostRef".into(), json!(self.host_ref));
        }
        binding.insert("remotePath".into(), json!(self.remote_path));
        Value::Object(binding)
    }

    /// Identity of the binding, used to detect that an anchor directory we would
    /// reuse actually points somewhere else.
    fn identity(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.host_ref,
            self.host,
            self.port.map(|p| p.to_string()).unwrap_or_default(),
            self.user,
            self.remote_path
        )
    }

    fn host_label(&self) -> &str {
        if self.host_ref.is_empty() {
            &self.host
        } else {
            &self.host_ref
        }
    }
}

/// `~/.picot/remotes` — the parent of every remote workspace anchor.
pub fn remotes_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot resolve the home directory".to_string())?;
    Ok(home.join(".picot").join("remotes"))
}

/// Create (or reuse) the anchor directory for `request` and persist its
/// `sshRemote` binding. Returns the directory to open as a workspace.
pub fn prepare_remote_anchor(
    request: &RemoteWorkspaceRequest,
    remotes_root: &Path,
) -> Result<PathBuf, String> {
    let request = request.trimmed();
    if request.host.is_empty() && request.host_ref.is_empty() {
        return Err("A host is required to open a remote workspace".into());
    }
    if request.remote_path.is_empty() {
        return Err("A remote path is required to open a remote workspace".into());
    }
    if !request.remote_path.starts_with('/') {
        return Err("The remote path must be absolute (start with /)".into());
    }

    let target = if request.user.is_empty() {
        request.host_label().to_string()
    } else {
        format!("{}@{}", request.user, request.host_label())
    };
    let anchor = remotes_root
        .join(sanitize_segment(&target))
        .join(anchor_leaf(
            &request,
            &remotes_root.join(sanitize_segment(&target)),
        ));

    std::fs::create_dir_all(&anchor)
        .map_err(|error| format!("Cannot create {}: {error}", anchor.display()))?;
    let settings_path = anchor.join(".pi").join("settings.json");
    // The anchor is created by this command at the user's request, so it is
    // trusted for the write; `--approve` at launch covers the pi side.
    SettingsStore::new(settings_path.clone(), settings_path, true).merge(
        SettingScope::Project,
        &json!({ "sshRemote": request.binding() }),
    )?;
    Ok(anchor)
}

/// Directory name for one remote path: the remote basename, so the workspace
/// reads like the project it is. A name already taken by a *different* binding
/// gets a short suffix instead of silently hijacking that workspace.
fn anchor_leaf(request: &RemoteWorkspaceRequest, host_dir: &Path) -> String {
    let base = request
        .remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("root");
    let leaf = sanitize_segment(base);
    if !conflicts_with_existing(request, &host_dir.join(&leaf)) {
        return leaf;
    }
    format!("{leaf}-{:08x}", fnv1a(&request.identity()))
}

/// True when `candidate` already holds an `sshRemote` binding for some other
/// host or remote path.
fn conflicts_with_existing(request: &RemoteWorkspaceRequest, candidate: &Path) -> bool {
    let settings_path = candidate.join(".pi").join("settings.json");
    let Ok(bytes) = std::fs::read(&settings_path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let Some(existing) = value.get("sshRemote") else {
        return false;
    };
    let field = |key: &str| {
        existing
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let port = existing
        .get("port")
        .and_then(Value::as_u64)
        .map(|port| port.to_string())
        .unwrap_or_default();
    let existing_identity = format!(
        "{}|{}|{}|{}|{}",
        field("hostRef"),
        field("host"),
        port,
        field("user"),
        field("remotePath")
    );
    existing_identity != request.identity()
}

/// Keep a path segment boring: one component, no separators, no surprises.
fn sanitize_segment(value: &str) -> String {
    let mut out = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '@') {
            out.push(character);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(|c| c == '-' || c == '.');
    let truncated: String = trimmed.chars().take(64).collect();
    if truncated.is_empty() {
        "remote".to_string()
    } else {
        truncated
    }
}

fn fnv1a(value: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(host: &str, remote_path: &str) -> RemoteWorkspaceRequest {
        RemoteWorkspaceRequest {
            host: host.into(),
            remote_path: remote_path.into(),
            user: "ubuntu".into(),
            ..RemoteWorkspaceRequest::default()
        }
    }

    #[test]
    fn creates_an_anchor_named_after_the_remote_basename() {
        let root = tempfile::tempdir().expect("tempdir");
        let anchor =
            prepare_remote_anchor(&request("10.0.0.5", "/data/proj"), root.path()).expect("anchor");
        assert_eq!(anchor, root.path().join("ubuntu@10.0.0.5").join("proj"));
        let settings: Value = serde_json::from_slice(
            &std::fs::read(anchor.join(".pi").join("settings.json")).expect("settings"),
        )
        .expect("json");
        assert_eq!(settings["sshRemote"]["enabled"], json!(true));
        assert_eq!(settings["sshRemote"]["host"], json!("10.0.0.5"));
        assert_eq!(settings["sshRemote"]["remotePath"], json!("/data/proj"));
    }

    #[test]
    fn reuses_the_same_anchor_for_the_same_binding() {
        let root = tempfile::tempdir().expect("tempdir");
        let first =
            prepare_remote_anchor(&request("10.0.0.5", "/data/proj"), root.path()).expect("first");
        let second =
            prepare_remote_anchor(&request("10.0.0.5", "/data/proj"), root.path()).expect("second");
        assert_eq!(first, second);
    }

    #[test]
    fn a_different_remote_path_with_the_same_basename_gets_its_own_anchor() {
        let root = tempfile::tempdir().expect("tempdir");
        let first =
            prepare_remote_anchor(&request("10.0.0.5", "/data/proj"), root.path()).expect("first");
        let second =
            prepare_remote_anchor(&request("10.0.0.5", "/srv/proj"), root.path()).expect("second");
        assert_ne!(first, second);
        assert!(second
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("proj-")));
    }

    #[test]
    fn an_aliased_binding_stores_no_credentials() {
        let root = tempfile::tempdir().expect("tempdir");
        let anchor = prepare_remote_anchor(
            &RemoteWorkspaceRequest {
                host_ref: "gpu-box".into(),
                remote_path: "/data/proj".into(),
                ..RemoteWorkspaceRequest::default()
            },
            root.path(),
        )
        .expect("anchor");
        assert_eq!(anchor, root.path().join("gpu-box").join("proj"));
        let settings: Value = serde_json::from_slice(
            &std::fs::read(anchor.join(".pi").join("settings.json")).expect("settings"),
        )
        .expect("json");
        assert_eq!(settings["sshRemote"]["hostRef"], json!("gpu-box"));
        assert!(settings["sshRemote"].get("host").is_none());
        assert!(settings["sshRemote"].get("identityFile").is_none());
    }

    #[test]
    fn preserves_unrelated_project_settings_when_rebinding() {
        let root = tempfile::tempdir().expect("tempdir");
        let anchor =
            prepare_remote_anchor(&request("10.0.0.5", "/data/proj"), root.path()).expect("anchor");
        let settings_path = anchor.join(".pi").join("settings.json");
        std::fs::write(
            &settings_path,
            serde_json::to_vec(&json!({ "sshRemote": { "enabled": true, "host": "10.0.0.5",
                "user": "ubuntu", "remotePath": "/data/proj" }, "theme": "dark" }))
            .expect("encode"),
        )
        .expect("write");
        prepare_remote_anchor(&request("10.0.0.5", "/data/proj"), root.path()).expect("rebind");
        let settings: Value =
            serde_json::from_slice(&std::fs::read(&settings_path).expect("settings"))
                .expect("json");
        assert_eq!(settings["theme"], json!("dark"));
    }

    #[test]
    fn rejects_a_relative_remote_path() {
        let root = tempfile::tempdir().expect("tempdir");
        let error = prepare_remote_anchor(&request("10.0.0.5", "proj"), root.path())
            .expect_err("relative path");
        assert!(error.contains("absolute"), "{error}");
    }

    #[test]
    fn rejects_a_request_without_a_host() {
        let root = tempfile::tempdir().expect("tempdir");
        let error = prepare_remote_anchor(&request("", "/data/proj"), root.path())
            .expect_err("missing host");
        assert!(error.contains("host"), "{error}");
    }

    #[test]
    fn sanitizes_hostile_path_segments() {
        assert_eq!(sanitize_segment("../../etc"), "etc");
        assert_eq!(sanitize_segment("a/b"), "a-b");
        assert_eq!(sanitize_segment(""), "remote");
        assert_eq!(sanitize_segment("ubuntu@10.0.0.5"), "ubuntu@10.0.0.5");
    }
}
