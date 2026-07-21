// ABOUTME: Owns per-window owner identity, bearer capability validation, and the
// ABOUTME: exact-origin navigation boundary for capability-bearing WebViews.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::rngs::OsRng;
use rand::RngCore;

const CAPABILITY_LEN: usize = 32;
const OWNER_ID_LEN: usize = 16;

/// Opaque per-window owner identity. Distinct from the bearer capability.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct OwnerId(String);

/// Shared registry of window owners, their capabilities, and navigation permits.
#[derive(Clone, Default)]
pub struct WindowOwnerRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

#[derive(Default)]
struct RegistryState {
    owners: HashMap<OwnerId, OwnerRecord>,
    // O(1) capability → owner lookup. Kept 1:1 with `owners` on insert and
    // revoke, so authentication stays constant-time over the owner count.
    capability_index: HashMap<[u8; CAPABILITY_LEN], OwnerId>,
    next_generation: u64,
}

struct OwnerRecord {
    window_label: String,
    canonical_cwd: PathBuf,
    primary_port: u16,
    current_origin: String,
    pending: Option<PendingNavigation>,
    transition: Option<WorkspaceTransition>,
    capability_bytes: [u8; CAPABILITY_LEN],
    workspace_generation: u64,
}

struct PendingNavigation {
    origin: String,
    #[allow(dead_code)]
    target_port: u16,
    #[allow(dead_code)]
    target_cwd: PathBuf,
    transition_generation: u64,
    expires_at: Instant,
    consumed: bool,
}

struct WorkspaceTransition {
    generation: u64,
    target_cwd: PathBuf,
    #[allow(dead_code)]
    target_port: u16,
}

impl WindowOwnerRegistry {
    pub fn create_owner(
        &self,
        window_label: String,
        canonical_cwd: PathBuf,
        primary_port: u16,
        current_origin: String,
    ) -> Result<(OwnerId, String), String> {
        let origin = normalize_origin(&current_origin)
            .ok_or_else(|| "owner origin must be an http loopback Pi origin".to_string())?;

        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        if state
            .owners
            .values()
            .any(|r| r.window_label == window_label)
        {
            return Err("window label is already owned".to_string());
        }

        let mut capability_bytes = [0u8; CAPABILITY_LEN];
        OsRng.fill_bytes(&mut capability_bytes);
        let mut id_bytes = [0u8; OWNER_ID_LEN];
        OsRng.fill_bytes(&mut id_bytes);

        let owner_id = OwnerId(hex_encode(&id_bytes));
        let capability = URL_SAFE_NO_PAD.encode(capability_bytes);
        state
            .capability_index
            .insert(capability_bytes, owner_id.clone());
        state.owners.insert(
            owner_id.clone(),
            OwnerRecord {
                window_label,
                canonical_cwd,
                primary_port,
                current_origin: origin,
                pending: None,
                transition: None,
                capability_bytes,
                workspace_generation: 0,
            },
        );
        Ok((owner_id, capability))
    }

    pub fn authenticate(&self, capability: &str) -> Option<OwnerId> {
        let decoded = URL_SAFE_NO_PAD.decode(capability).ok()?;
        if decoded.len() != CAPABILITY_LEN {
            return None;
        }
        let mut bytes = [0u8; CAPABILITY_LEN];
        bytes.copy_from_slice(&decoded);

        let state = self.inner.lock().expect("owner registry lock poisoned");
        // O(1) direct lookup. The key is the full 256-bit capability, so
        // timing no longer varies with the number of owners.
        state.capability_index.get(&bytes).cloned()
    }

    pub fn prepare_navigation(
        &self,
        owner: &OwnerId,
        port: u16,
        canonical_cwd: PathBuf,
        origin: String,
        ttl: Duration,
    ) -> Result<u64, String> {
        let origin = normalize_origin(&origin)
            .ok_or_else(|| "navigation origin must be an http loopback Pi origin".to_string())?;
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        let transition_gen = state
            .owners
            .get(owner)
            .ok_or_else(|| "unknown owner".to_string())?
            .transition
            .as_ref()
            .map(|t| t.generation);
        let generation = match transition_gen {
            Some(g) => g,
            None => {
                state.next_generation += 1;
                state.next_generation
            }
        };
        let record = state
            .owners
            .get_mut(owner)
            .ok_or_else(|| "unknown owner".to_string())?;
        record.pending = Some(PendingNavigation {
            origin,
            target_port: port,
            target_cwd: canonical_cwd,
            transition_generation: generation,
            expires_at: Instant::now() + ttl,
            consumed: false,
        });
        Ok(generation)
    }

    pub fn authorize_navigation(&self, owner: &OwnerId, url: &tauri::Url) -> bool {
        let Some(origin) = url_origin(url) else {
            return false;
        };
        let mut state = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        let Some(record) = state.owners.get_mut(owner) else {
            return false;
        };
        if origin == record.current_origin {
            return true;
        }
        if let Some(pending) = record.pending.as_mut() {
            if !pending.consumed && Instant::now() < pending.expires_at && origin == pending.origin
            {
                pending.consumed = true;
                return true;
            }
        }
        false
    }

    pub fn begin_workspace_transition(
        &self,
        owner: &OwnerId,
        target_cwd: PathBuf,
        target_port: u16,
    ) -> Result<u64, String> {
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        if state
            .owners
            .get(owner)
            .ok_or_else(|| "unknown owner".to_string())?
            .transition
            .is_some()
        {
            return Err("a workspace transition is already in progress".to_string());
        }
        state.next_generation += 1;
        let generation = state.next_generation;
        let record = state
            .owners
            .get_mut(owner)
            .ok_or_else(|| "unknown owner".to_string())?;
        record.transition = Some(WorkspaceTransition {
            generation,
            target_cwd,
            target_port,
        });
        Ok(generation)
    }

    pub fn commit_workspace_transition(
        &self,
        owner: &OwnerId,
        transition_generation: u64,
        target_origin: String,
    ) -> Result<(), String> {
        let target = normalize_origin(&target_origin)
            .ok_or_else(|| "commit origin must be an http loopback Pi origin".to_string())?;
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        let record = state
            .owners
            .get_mut(owner)
            .ok_or_else(|| "unknown owner".to_string())?;

        let (target_port, new_cwd) = {
            let pending = record
                .pending
                .as_ref()
                .ok_or_else(|| "no pending navigation permit to commit".to_string())?;
            if pending.transition_generation != transition_generation {
                return Err("transition generation mismatch".to_string());
            }
            if pending.origin != target {
                return Err("commit origin does not match the prepared permit".to_string());
            }
            let new_cwd = record
                .transition
                .as_ref()
                .filter(|t| t.generation == transition_generation)
                .map(|t| t.target_cwd.clone());
            (pending.target_port, new_cwd)
        };

        record.primary_port = target_port;
        if let Some(cwd) = new_cwd {
            record.canonical_cwd = cwd;
        }
        record.current_origin = target;
        record.workspace_generation = transition_generation;
        record.pending = None;
        record.transition = None;
        Ok(())
    }

    pub fn current_workspace(&self, owner: &OwnerId) -> Option<(PathBuf, u16)> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .map(|r| (r.canonical_cwd.clone(), r.primary_port))
    }

    pub fn workspace_transition_in_progress(&self, owner: &OwnerId) -> bool {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .is_some_and(|record| record.transition.is_some())
    }

    /// The workspace transition generation that established the owner's current
    /// workspace binding. Ephemeral records snapshot this at creation so
    /// cross-workspace cleanup can identify old-workspace chats.
    pub fn current_workspace_generation(&self, owner: &OwnerId) -> Option<u64> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state.owners.get(owner).map(|r| r.workspace_generation)
    }

    /// The pending navigation permit's target origin, if one is prepared but not
    /// yet committed. Used by the workspace-transition commit path.
    pub fn pending_target_origin(&self, owner: &OwnerId) -> Option<String> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .and_then(|r| r.pending.as_ref().map(|p| p.origin.clone()))
    }

    /// The pending navigation permit's target port, if one is prepared.
    pub fn pending_target_port(&self, owner: &OwnerId) -> Option<u16> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .and_then(|r| r.pending.as_ref().map(|p| p.target_port))
    }

    /// The pending navigation permit's canonical target cwd, if one is prepared.
    pub fn pending_target_cwd(&self, owner: &OwnerId) -> Option<PathBuf> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .and_then(|r| r.pending.as_ref().map(|p| p.target_cwd.clone()))
    }

    /// Resolve the owner bound to a window label (used by the close lifecycle).
    pub fn owner_for_label(&self, label: &str) -> Option<OwnerId> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .iter()
            .find(|(_, r)| r.window_label == label)
            .map(|(owner, _)| owner.clone())
    }

    /// The window label bound to an owner.
    pub fn label_for_owner(&self, owner: &OwnerId) -> Option<String> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state.owners.get(owner).map(|r| r.window_label.clone())
    }

    /// Cancel an in-progress workspace transition for this owner, retaining the
    /// old workspace binding. Idempotent when nothing is in progress; rejects a
    /// mismatched generation so a stale cancel cannot clear a newer transition.
    pub fn cancel_workspace_transition(
        &self,
        owner: &OwnerId,
        transition_generation: u64,
    ) -> Result<(), String> {
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        let Some(record) = state.owners.get_mut(owner) else {
            return Err("unknown owner".to_string());
        };
        let pending_gen = record.pending.as_ref().map(|p| p.transition_generation);
        let transition_gen = record.transition.as_ref().map(|t| t.generation);
        if pending_gen.is_none() && transition_gen.is_none() {
            return Ok(());
        }
        if pending_gen.is_some_and(|g| g != transition_generation)
            || transition_gen.is_some_and(|g| g != transition_generation)
        {
            return Err("transition generation mismatch".to_string());
        }
        record.pending = None;
        record.transition = None;
        Ok(())
    }

    pub fn revoke_owner(&self, owner: &OwnerId) {
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        if let Some(record) = state.owners.remove(owner) {
            state.capability_index.remove(&record.capability_bytes);
        }
    }
}

/// Static initialization script that exposes the bearer capability only when
/// the document is Picot's canonical native http loopback origin. Defense in
/// depth behind the host navigation callback; never an authorization boundary.
pub fn capability_initialization_script(
    loopback_host: &str,
    port: u16,
    capability: &str,
) -> String {
    let host = serde_json::to_string(loopback_host).expect("host JSON");
    let port_str = port.to_string();
    let token = serde_json::to_string(capability).expect("capability JSON");
    format!(
        "if (window.location.protocol === 'http:' && window.location.hostname === {host} && String(window.location.port) === \"{port_str}\") {{ Object.defineProperty(window, '__PICOT_NATIVE_CAPABILITY__', {{ value: {token}, configurable: true }}); }}"
    )
}

fn normalize_origin(origin: &str) -> Option<String> {
    let url: tauri::Url = origin.parse().ok()?;
    url_origin(&url)
}

fn url_origin(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "http" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    if !is_loopback_host(host) {
        return None;
    }
    let port = url.port_or_known_default()?;
    Some(format!("http://{host}:{port}"))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost")
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        s.parse().expect("valid url")
    }

    fn new_owner(reg: &WindowOwnerRegistry, label: &str, port: u16) -> (OwnerId, String) {
        reg.create_owner(
            label.to_string(),
            PathBuf::from("/workspace"),
            port,
            format!("http://127.0.0.1:{port}"),
        )
        .expect("owner created")
    }

    #[test]
    fn capability_is_32_random_url_safe_bytes() {
        let reg = WindowOwnerRegistry::default();
        let (owner, capability) = new_owner(&reg, "w1", 3001);
        assert_eq!(owner.0.len(), 32); // 16 bytes hex
        let decoded = URL_SAFE_NO_PAD.decode(&capability).expect("decodes");
        assert_eq!(decoded.len(), CAPABILITY_LEN);
        for ch in capability.chars() {
            assert!(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
            assert!(ch != '='); // no padding
        }
    }

    #[test]
    fn authenticate_validates_in_constant_time() {
        let reg = WindowOwnerRegistry::default();
        let (owner, capability) = new_owner(&reg, "w1", 3001);

        assert_eq!(reg.authenticate(&capability), Some(owner.clone()));

        // Tamper one byte -> still 32 bytes, must not match.
        let bytes = URL_SAFE_NO_PAD.decode(&capability).unwrap();
        let mut flipped = bytes.clone();
        flipped[0] ^= 0xff;
        let tampered = URL_SAFE_NO_PAD.encode(&flipped);
        assert_eq!(reg.authenticate(&tampered), None);

        // Wrong length / garbage -> None, never panics.
        assert_eq!(reg.authenticate("short"), None);
        assert_eq!(reg.authenticate(""), None);
    }

    #[test]
    fn window_label_can_be_reused_after_revocation() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        assert!(reg
            .create_owner(
                "w1".to_string(),
                PathBuf::from("/ws"),
                3002,
                "http://127.0.0.1:3002".to_string(),
            )
            .is_err());
        reg.revoke_owner(&owner);
        assert!(new_owner(&reg, "w1", 3003).0 != owner);
    }

    #[test]
    fn current_exact_origin_is_authorized() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3001/chat")));
        // Same host, different port is not equivalent.
        assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/chat")));
    }

    #[test]
    fn prepared_pending_origin_is_authorized_within_ttl() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        let gen = reg
            .prepare_navigation(
                &owner,
                3002,
                PathBuf::from("/workspace"),
                "http://127.0.0.1:3002".to_string(),
                Duration::from_secs(5),
            )
            .expect("prepare");
        assert!(gen > 0);
        assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/x")));
        // A pending destination is a one-shot bearer permit.
        assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/again")));
        // Old origin remains valid alongside the pending permit.
        assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3001/x")));
    }

    #[test]
    fn expired_permit_is_not_authorized_but_current_remains() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        reg.prepare_navigation(
            &owner,
            3002,
            PathBuf::from("/workspace"),
            "http://127.0.0.1:3002".to_string(),
            Duration::ZERO,
        )
        .expect("prepare");
        assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/x")));
        assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3001/x")));
    }

    #[test]
    fn permit_is_consumed_by_commit_and_old_origin_becomes_unauthorized() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        let gen = reg
            .prepare_navigation(
                &owner,
                3002,
                PathBuf::from("/workspace"),
                "http://127.0.0.1:3002".to_string(),
                Duration::from_secs(5),
            )
            .unwrap();
        assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/x")));

        reg.commit_workspace_transition(&owner, gen, "http://127.0.0.1:3002".to_string())
            .unwrap();

        // New origin is now current; a redirect back to the old origin is rejected.
        assert!(reg.authorize_navigation(&owner, &url("http://127.0.0.1:3002/x")));
        assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3001/x")));
        // No pending permit remains for an unregistered third origin.
        assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:3003/x")));
    }

    #[test]
    fn non_loopback_or_non_http_destinations_are_rejected() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        assert!(!reg.authorize_navigation(&owner, &url("https://example.com/")));
        assert!(!reg.authorize_navigation(&owner, &url("http://192.168.1.5:3001/")));
        assert!(!reg.authorize_navigation(&owner, &url("file:///etc/passwd")));
        assert!(!reg.authorize_navigation(&owner, &url("picot://internal/app")));
    }

    #[test]
    fn unregistered_loopback_ports_are_rejected() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        assert!(!reg.authorize_navigation(&owner, &url("http://localhost:9999/")));
        assert!(!reg.authorize_navigation(&owner, &url("http://127.0.0.1:9999/")));
    }

    #[test]
    fn userinfo_is_rejected() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        assert!(!reg.authorize_navigation(&owner, &url("http://user:pass@127.0.0.1:3001/")));
    }

    #[test]
    fn owner_isolation_prevents_cross_owner_authorization() {
        let reg = WindowOwnerRegistry::default();
        let (owner_a, cap_a) = new_owner(&reg, "w1", 3001);
        let (owner_b, cap_b) = new_owner(&reg, "w2", 3002);
        // owner_b cannot authorize owner_a's current origin.
        assert!(!reg.authorize_navigation(&owner_b, &url("http://127.0.0.1:3001/x")));
        // Each capability authenticates as exactly its own owner, never the other.
        assert_eq!(reg.authenticate(&cap_a), Some(owner_a));
        assert_eq!(reg.authenticate(&cap_b), Some(owner_b));
        assert_ne!(reg.authenticate(&cap_a), reg.authenticate(&cap_b));
    }

    #[test]
    fn capability_never_appears_in_debug_or_descriptors() {
        let reg = WindowOwnerRegistry::default();
        let (owner, capability) = new_owner(&reg, "w1", 3001);
        let debug = format!("{owner:?}");
        assert!(!debug.contains(&capability));
        // current_workspace descriptor carries no capability either.
        let (cwd, port) = reg.current_workspace(&owner).unwrap();
        assert_eq!(port, 3001);
        assert!(!format!("{cwd:?}").contains(&capability));
    }

    #[test]
    fn initialization_script_guards_capability_behind_loopback_origin_and_port() {
        let script = capability_initialization_script("127.0.0.1", 3001, "secret-cap");
        assert!(script.contains("\"secret-cap\""));
        assert!(script.contains("\"127.0.0.1\""));
        assert!(script.contains("window.location.protocol === 'http:'"));
        assert!(script.contains("window.location.hostname === \"127.0.0.1\""));
        // Defense in depth: the capability is only exposed at the exact owner
        // port, never at another loopback service.
        assert!(script.contains("String(window.location.port) === \"3001\""));
        assert!(script.contains("__PICOT_NATIVE_CAPABILITY__"));
    }

    #[test]
    fn workspace_transition_updates_cwd_and_port_on_commit() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        let gen = reg
            .begin_workspace_transition(&owner, PathBuf::from("/ws-b"), 3002)
            .unwrap();
        reg.prepare_navigation(
            &owner,
            3002,
            PathBuf::from("/ws-b"),
            "http://127.0.0.1:3002".to_string(),
            Duration::from_secs(5),
        )
        .unwrap();
        reg.commit_workspace_transition(&owner, gen, "http://127.0.0.1:3002".to_string())
            .unwrap();
        let (cwd, port) = reg.current_workspace(&owner).unwrap();
        assert_eq!(cwd, PathBuf::from("/ws-b"));
        assert_eq!(port, 3002);
    }

    #[test]
    fn pending_target_origin_tracks_prepare_and_commit() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        assert_eq!(reg.pending_target_origin(&owner), None);
        reg.prepare_navigation(
            &owner,
            3002,
            PathBuf::from("/workspace"),
            "http://127.0.0.1:3002".to_string(),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(
            reg.pending_target_origin(&owner).as_deref(),
            Some("http://127.0.0.1:3002")
        );
        let gen = reg
            .begin_workspace_transition(&owner, PathBuf::from("/ws-b"), 3002)
            .unwrap();
        // prepare during an active transition reuses that generation.
        let prepare_gen = reg
            .prepare_navigation(
                &owner,
                3002,
                PathBuf::from("/ws-b"),
                "http://127.0.0.1:3002".to_string(),
                Duration::from_secs(5),
            )
            .unwrap();
        assert_eq!(prepare_gen, gen);
        reg.commit_workspace_transition(&owner, gen, "http://127.0.0.1:3002".to_string())
            .unwrap();
        assert_eq!(reg.pending_target_origin(&owner), None);
    }

    #[test]
    fn cancel_workspace_transition_retains_old_binding() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        let gen = reg
            .begin_workspace_transition(&owner, PathBuf::from("/ws-b"), 3002)
            .unwrap();
        reg.prepare_navigation(
            &owner,
            3002,
            PathBuf::from("/ws-b"),
            "http://127.0.0.1:3002".to_string(),
            Duration::from_secs(5),
        )
        .unwrap();

        reg.cancel_workspace_transition(&owner, gen).unwrap();
        // Old binding retained: cwd/port/origin unchanged, no pending/transition.
        let (cwd, port) = reg.current_workspace(&owner).unwrap();
        assert_eq!(cwd, PathBuf::from("/workspace"));
        assert_eq!(port, 3001);
        assert_eq!(reg.pending_target_origin(&owner), None);
        // A new transition can begin after cancel.
        assert!(reg
            .begin_workspace_transition(&owner, PathBuf::from("/ws-c"), 3003)
            .is_ok());
    }

    #[test]
    fn cancel_workspace_transition_rejects_mismatched_generation() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        let gen = reg
            .begin_workspace_transition(&owner, PathBuf::from("/ws-b"), 3002)
            .unwrap();
        assert!(reg.cancel_workspace_transition(&owner, gen + 999).is_err());
        // The transition is still in progress.
        assert!(reg
            .begin_workspace_transition(&owner, PathBuf::from("/ws-c"), 3003)
            .is_err());
    }

    #[test]
    fn cancel_is_idempotent_when_nothing_in_progress() {
        let reg = WindowOwnerRegistry::default();
        let (owner, _) = new_owner(&reg, "w1", 3001);
        assert!(reg.cancel_workspace_transition(&owner, 42).is_ok());
    }
}
