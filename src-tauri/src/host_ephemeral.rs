// ABOUTME: Spawns and manages ephemeral Pi chat instances (Side Chat, Quick Chat).
// ABOUTME: Each ephemeral chat is a standalone `pi --mode rpc` process registered
// ABOUTME: in NativePiManager under a synthetic RuntimeTarget. The frontend
// ABOUTME: communicates with it via the same runtime_subscribe / runtime_request
// ABOUTME: protocol used for the main workspace session — no separate transport.

use crate::native_pi_manager::{NativeLaunchSpec, NativePiManager};
use crate::pi_launch::PiLaunchResolver;
use crate::runtime_coordinator::RuntimeTarget;
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

/// The ephemeral kind: "side-chat" or "quick-chat".
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EphemeralKind {
    SideChat,
    QuickChat,
}

impl EphemeralKind {
    fn as_str(&self) -> &'static str {
        match self {
            EphemeralKind::SideChat => "side-chat",
            EphemeralKind::QuickChat => "quick-chat",
        }
    }
}

/// Create a fresh, empty temporary directory for a Quick Chat runtime.
///
/// Quick Chat never sees a user workspace: its cwd is an OS-temp directory
/// named `picot-quick-chat-<random>` so the embedded Pi has no project files
/// and no workspace-local resources. The directory is intentionally not
/// removed on close — it is empty by construction and lives in the OS temp
/// dir, so cleanup is delegated to the OS temp policy.
pub fn create_quick_chat_temp_dir() -> Result<PathBuf, String> {
    let unique = Uuid::new_v4().simple().to_string();
    let dir = std::env::temp_dir().join(format!("picot-quick-chat-{unique}"));
    std::fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "Cannot create Quick Chat temp dir {}: {error}",
            dir.display()
        )
    })?;
    Ok(dir)
}

/// Spawn an ephemeral Pi instance and register it in NativePiManager.
///
/// Returns a descriptor the frontend uses to subscribe to the instance:
/// `{ kind, instanceId, sessionId, workspaceId }`.
///
/// For Side Chat, the cwd is the owner's workspace path so tools (file read,
/// bash) work in the same project context. For Quick Chat the cwd is a fresh
/// OS-temp directory and the process runs with `--no-tools` — no built-in,
/// extension, or custom tools are exposed.
pub fn create_ephemeral(
    kind: EphemeralKind,
    workspace_cwd: &str,
    runtimes: &NativePiManager,
    launch: &PiLaunchResolver,
) -> Result<Value, String> {
    let unique = Uuid::new_v4().simple().to_string();
    let instance_id = format!("ephemeral-{}-{unique}", kind.as_str());
    let workspace_id = format!("ephemeral-ws-{unique}");

    let launch_spec = build_ephemeral_launch_spec(launch, workspace_cwd, kind)?;

    let target = RuntimeTarget::new(
        workspace_id.clone(),
        instance_id.clone(),
        instance_id.clone(),
    );
    runtimes.spawn(target, launch_spec)?;

    Ok(json!({
        "kind": kind.as_str(),
        "instanceId": instance_id,
        "sessionId": instance_id,
        "workspaceId": workspace_id,
    }))
}

/// Replace the single Quick Chat instance with a fresh one.
///
/// Spawns the new process first; only after it is registered does the old one
/// stop. If spawn fails, the old Quick Chat stays alive untouched — matching
/// the design contract "creation fails while the old child is alive → the
/// existing Quick Chat and its visible content remain intact".
pub fn replace_quick(
    workspace_cwd: &str,
    runtimes: &NativePiManager,
    launch: &PiLaunchResolver,
) -> Result<Value, String> {
    let unique = Uuid::new_v4().simple().to_string();
    let instance_id = format!("ephemeral-quick-chat-{unique}");
    let workspace_id = format!("ephemeral-ws-{unique}");
    let launch_spec = build_ephemeral_launch_spec(launch, workspace_cwd, EphemeralKind::QuickChat)?;

    let target = RuntimeTarget::new(
        workspace_id.clone(),
        instance_id.clone(),
        instance_id.clone(),
    );
    runtimes.spawn(target, launch_spec)?;

    // Stop any previous Quick Chat instance (at most one exists). Instance ids
    // carry the "ephemeral-quick-chat-" prefix, so stop those that are not the
    // freshly spawned one.
    if let Ok(statuses) = runtimes.statuses() {
        for status in statuses {
            if status
                .target
                .instance_id
                .starts_with("ephemeral-quick-chat-")
                && status.target.instance_id != instance_id
            {
                let _ = runtimes.stop(&status.target);
            }
        }
    }

    Ok(json!({
        "kind": "quick-chat",
        "instanceId": instance_id,
        "sessionId": instance_id,
        "workspaceId": workspace_id,
    }))
}

/// Close an ephemeral instance by stopping its Pi process in NativePiManager.
pub fn close_ephemeral(runtimes: &NativePiManager, instance_id: &str) -> Result<(), String> {
    // The instance_id is used as both the target's instanceId and sessionId.
    if let Some(target) = runtimes.target_for_session_id(instance_id) {
        runtimes.stop(&target)?;
    }
    Ok(())
}

fn build_ephemeral_launch_spec(
    launch: &PiLaunchResolver,
    workspace_cwd: &str,
    kind: EphemeralKind,
) -> Result<NativeLaunchSpec, String> {
    match kind {
        EphemeralKind::SideChat => launch.native_launch_spec(workspace_cwd, None),
        EphemeralKind::QuickChat => {
            // Quick Chat: fresh OS-temp cwd + --no-tools. Extensions still
            // load normally (design: "Global extensions, skills, prompt
            // templates, and settings are loaded by Pi").
            let temp_dir = create_quick_chat_temp_dir()?;
            let mut spec = launch.native_launch_spec(temp_dir.to_str().unwrap_or("/"), None)?;
            spec.no_tools = true;
            Ok(spec)
        }
    }
}
