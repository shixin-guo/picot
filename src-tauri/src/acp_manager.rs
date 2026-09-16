#![allow(dead_code)]

use crate::acp_launch::AcpLaunchSpec;
use crate::native_pi_manager::NativeRuntimeEvent;
use crate::pi_rpc_bridge::{BridgeFrame, PiRpcBridge, PiRpcProcess};
use crate::runtime_coordinator::{RuntimeCoordinator, RuntimeState, RuntimeTarget};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

const MAX_ACP_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// `initialize`/`session/new` are one-shot handshake calls; generous but
/// bounded so a hung ACP adapter fails the `#`-picker instead of hanging it.
const ACP_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

struct ManagedAcpRuntime {
    target: Arc<Mutex<RuntimeTarget>>,
    bridge: PiRpcBridge,
    process: Option<PiRpcProcess>,
    acp_session_id: String,
}

struct AcpAgentManagerInner {
    coordinator: Mutex<RuntimeCoordinator>,
    runtimes: Mutex<HashMap<String, ManagedAcpRuntime>>,
    events: broadcast::Sender<NativeRuntimeEvent>,
    /// Agent-initiated `session/request_permission` calls awaiting a human
    /// answer, keyed by `"{instance_id}:{request_key}"` (the composer/panel
    /// only ever sees `request_key`); the value is the ACP request's own `id`
    /// so the eventual reply can echo it back verbatim.
    pending_permissions: Mutex<HashMap<String, Value>>,
}

/// Mirrors `NativePiManager`'s shape for external Agent Client Protocol (ACP)
/// agents (Claude Code today; Codex/Cursor are follow-up presets). Reuses
/// `PiRpcBridge` as the stdio transport — it's already a generic
/// newline-delimited-JSON request/response/event bridge that only assumes an
/// `id` field for correlation, which ACP's JSON-RPC 2.0 framing satisfies —
/// and keeps its own `RuntimeCoordinator` so a session can move from the Pi
/// backend to an ACP backend (and back) without instance collisions.
#[derive(Clone)]
pub struct AcpAgentManager {
    inner: Arc<AcpAgentManagerInner>,
}

impl AcpAgentManager {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(AcpAgentManagerInner {
                coordinator: Mutex::new(RuntimeCoordinator::new(1)),
                runtimes: Mutex::new(HashMap::new()),
                events,
                pending_permissions: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Spawns the agent subprocess, runs the `initialize` + `session/new`
    /// handshake, and registers the runtime. Returns the ACP-side session id
    /// (distinct from Picot's own `RuntimeTarget.session_id`).
    pub async fn spawn(
        &self,
        target: RuntimeTarget,
        spec: AcpLaunchSpec,
    ) -> Result<String, String> {
        let mut command = Command::new(&spec.command);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            // A macOS/Linux GUI launch inherits a bare `PATH` that rarely
            // contains `npx`/`node`, so reuse the same PATH the embedded Pi
            // runtime is spawned with — otherwise `#claude` fails with an
            // opaque "No such file or directory".
            .env("PATH", crate::pi_launch::build_augmented_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().map_err(|error| {
            format!(
                "Cannot start ACP agent '{}' ({}): {error}",
                spec.agent_id, spec.command
            )
        })?;
        let (bridge, mut process) = PiRpcBridge::attach(child, MAX_ACP_FRAME_BYTES)?;

        // Fold whatever the agent printed to stderr into the failure message —
        // for a crash-on-startup that text ("not logged in", a stack trace) is
        // the only actionable detail the user gets.
        fn with_stderr(process: &PiRpcProcess, message: String) -> String {
            match process.drain_diagnostics() {
                Some(diagnostics) => format!("{message}\n--- agent stderr ---\n{diagnostics}"),
                None => message,
            }
        }

        let initialize = json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": false
                }
            }
        });
        let init_response = bridge
            .request(initialize, ACP_HANDSHAKE_TIMEOUT)
            .await
            .map_err(|error| {
                let message = with_stderr(&process, format!("ACP initialize failed: {error:?}"));
                let _ = process.kill();
                message
            })?;
        if let Some(error) = init_response.get("error") {
            let message = with_stderr(&process, format!("ACP initialize rejected: {error}"));
            let _ = process.kill();
            return Err(message);
        }

        let new_session = json!({
            "jsonrpc": "2.0",
            "method": "session/new",
            "params": { "cwd": spec.cwd.to_string_lossy(), "mcpServers": [] }
        });
        let session_response = bridge
            .request(new_session, ACP_HANDSHAKE_TIMEOUT)
            .await
            .map_err(|error| {
                let message = with_stderr(&process, format!("ACP session/new failed: {error:?}"));
                let _ = process.kill();
                message
            })?;
        if let Some(error) = session_response.get("error") {
            let message = with_stderr(&process, format!("ACP session/new rejected: {error}"));
            let _ = process.kill();
            return Err(message);
        }
        let acp_session_id = session_response
            .get("result")
            .and_then(|result| result.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(acp_session_id) = acp_session_id else {
            let _ = process.kill();
            return Err("ACP session/new returned no sessionId".to_string());
        };

        if let Err(error) = self
            .inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .register(target.clone(), RuntimeState::Ready)
        {
            let _ = process.kill();
            return Err(format!("Cannot register ACP runtime: {error:?}"));
        }
        self.inner
            .runtimes
            .lock()
            .map_err(|_| "ACP runtime registry lock poisoned".to_string())?
            .insert(
                target.instance_id.clone(),
                ManagedAcpRuntime {
                    target: Arc::new(Mutex::new(target.clone())),
                    bridge: bridge.clone(),
                    process: Some(process),
                    acp_session_id: acp_session_id.clone(),
                },
            );
        self.start_event_pump(target, bridge, spec.cwd);
        Ok(acp_session_id)
    }

    fn start_event_pump(&self, target: RuntimeTarget, bridge: PiRpcBridge, cwd: PathBuf) {
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = bridge.next_frame().await {
                let current_target = inner.runtimes.lock().ok().and_then(|runtimes| {
                    runtimes
                        .get(&target.instance_id)?
                        .target
                        .lock()
                        .ok()
                        .map(|target| target.clone())
                });
                let Some(current_target) = current_target else {
                    return;
                };
                match frame {
                    BridgeFrame::ProtocolError(message) => {
                        broadcast_event(
                            &inner,
                            &current_target,
                            json!({ "type": "acp_error", "message": message }),
                        );
                    }
                    BridgeFrame::Event(event) | BridgeFrame::ExtensionUi(event) => {
                        handle_agent_frame(&inner, &current_target, &bridge, &cwd, event).await;
                    }
                }
            }
            remove_closed_runtime(&inner, &target.instance_id);
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NativeRuntimeEvent> {
        self.inner.events.subscribe()
    }

    /// True when `target` names a runtime this manager currently owns — used
    /// by the host dispatcher to pick between the Pi and ACP managers for a
    /// given `runtime_request` without adding a separate backend-kind map.
    pub fn owns(&self, target: &RuntimeTarget) -> bool {
        self.inner
            .coordinator
            .lock()
            .map(|coordinator| coordinator.validate(target).is_ok())
            .unwrap_or(false)
    }

    pub async fn request(
        &self,
        target: &RuntimeTarget,
        command: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("ACP request rejected: {error:?}"))?;
        let (bridge, acp_session_id) = {
            let runtimes = self
                .inner
                .runtimes
                .lock()
                .map_err(|_| "ACP runtime registry lock poisoned".to_string())?;
            let managed = runtimes
                .get(&target.instance_id)
                .ok_or_else(|| "ACP runtime instance is not running".to_string())?;
            (managed.bridge.clone(), managed.acp_session_id.clone())
        };
        match command.get("type").and_then(Value::as_str) {
            Some("acp_prompt") => {
                let payload = json!({
                    "jsonrpc": "2.0",
                    "method": "session/prompt",
                    "params": {
                        "sessionId": acp_session_id,
                        "prompt": build_prompt_blocks(&command),
                    }
                });
                let response = bridge
                    .request(payload, timeout)
                    .await
                    .map_err(|error| format!("ACP session/prompt failed: {error:?}"))?;
                unwrap_jsonrpc_result(response)
            }
            Some("acp_cancel") => {
                let payload = json!({
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": { "sessionId": acp_session_id }
                });
                bridge
                    .send_frame(payload)
                    .await
                    .map_err(|error| format!("ACP session/cancel failed: {error:?}"))?;
                Ok(json!({ "acknowledged": true }))
            }
            other => Err(format!("Unsupported ACP command: {other:?}")),
        }
    }

    /// Answers an agent-initiated `session/request_permission` call. `response`
    /// is Picot's own envelope: `{"requestId": "<key>", "optionId": "<id>"}`
    /// (absent `optionId` means the user dismissed the prompt).
    pub async fn respond_permission(
        &self,
        target: &RuntimeTarget,
        response: Value,
    ) -> Result<(), String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("ACP permission response rejected: {error:?}"))?;
        let request_key = response
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| "requestId is required".to_string())?;
        let key = format!("{}:{request_key}", target.instance_id);
        let original_id = self
            .inner
            .pending_permissions
            .lock()
            .map_err(|_| "ACP pending-permission lock poisoned".to_string())?
            .remove(&key)
            .ok_or_else(|| "Unknown or already-answered permission request".to_string())?;
        let outcome = match response.get("optionId").and_then(Value::as_str) {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let bridge = {
            let runtimes = self
                .inner
                .runtimes
                .lock()
                .map_err(|_| "ACP runtime registry lock poisoned".to_string())?;
            runtimes
                .get(&target.instance_id)
                .ok_or_else(|| "ACP runtime instance is not running".to_string())?
                .bridge
                .clone()
        };
        bridge
            .send_frame(
                json!({ "jsonrpc": "2.0", "id": original_id, "result": { "outcome": outcome } }),
            )
            .await
            .map_err(|error| format!("Cannot send ACP permission response: {error:?}"))
    }

    pub fn stop(&self, target: &RuntimeTarget) -> Result<(), String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("ACP stop rejected: {error:?}"))?;
        let mut runtime = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "ACP runtime registry lock poisoned".to_string())?
            .remove(&target.instance_id)
            .ok_or_else(|| "ACP runtime instance is not running".to_string())?;
        if let Some(process) = &mut runtime.process {
            process.kill()?;
        }
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "ACP coordinator lock poisoned".to_string())?
            .unregister(target)
            .map_err(|error| format!("Cannot unregister stopped ACP runtime: {error:?}"))?;
        if let Ok(mut pending) = self.inner.pending_permissions.lock() {
            let prefix = format!("{}:", target.instance_id);
            pending.retain(|key, _| !key.starts_with(&prefix));
        }
        Ok(())
    }

    pub fn stop_workspace(&self, workspace_id: &str) {
        let targets = self
            .inner
            .runtimes
            .lock()
            .map(|runtimes| {
                runtimes
                    .values()
                    .filter_map(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
                    .filter(|target| target.workspace_id == workspace_id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for target in targets {
            let _ = self.stop(&target);
        }
    }

    pub fn stop_all(&self) {
        let targets = self
            .inner
            .runtimes
            .lock()
            .map(|runtimes| {
                runtimes
                    .values()
                    .filter_map(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for target in targets {
            let _ = self.stop(&target);
        }
    }

    pub fn target_for_session(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Option<RuntimeTarget> {
        self.inner
            .runtimes
            .lock()
            .ok()?
            .values()
            .find(|runtime| {
                runtime.target.lock().is_ok_and(|target| {
                    target.workspace_id == workspace_id && target.session_id == session_id
                })
            })
            .and_then(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
    }

    pub fn target_for_session_id(&self, session_id: &str) -> Option<RuntimeTarget> {
        self.inner
            .runtimes
            .lock()
            .ok()?
            .values()
            .find(|runtime| {
                runtime
                    .target
                    .lock()
                    .is_ok_and(|target| target.session_id == session_id)
            })
            .and_then(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
    }
}

impl Default for AcpAgentManager {
    fn default() -> Self {
        Self::new()
    }
}

fn build_prompt_blocks(command: &Value) -> Vec<Value> {
    let mut blocks = Vec::new();
    if let Some(message) = command.get("message").and_then(Value::as_str) {
        if !message.is_empty() {
            blocks.push(json!({ "type": "text", "text": message }));
        }
    }
    if let Some(images) = command.get("images").and_then(Value::as_array) {
        for image in images {
            let Some(data) = image.get("data").and_then(Value::as_str) else {
                continue;
            };
            let mime_type = image
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            blocks.push(json!({ "type": "image", "data": data, "mimeType": mime_type }));
        }
    }
    blocks
}

fn unwrap_jsonrpc_result(response: Value) -> Result<Value, String> {
    if let Some(error) = response.get("error") {
        return Err(format!("ACP agent returned an error: {error}"));
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

fn jsonrpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Resolves `path` (which ACP sends as an absolute path) against `cwd`,
/// requiring the result to stay inside the workspace root — the same scoping
/// boundary the rest of the host data plane enforces for file access.
fn resolve_in_workspace(cwd: &Path, path: &str, require_existing: bool) -> Option<PathBuf> {
    let requested = PathBuf::from(path);
    let resolved = if requested.is_absolute() {
        requested
    } else {
        cwd.join(requested)
    };
    let canonical_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let canonical_target = if require_existing {
        resolved.canonicalize().ok()?
    } else {
        // A file being created doesn't exist yet — canonicalize its parent
        // directory instead and re-attach the file name.
        let parent = resolved.parent().unwrap_or(&resolved);
        let canonical_parent = parent.canonicalize().ok()?;
        match resolved.file_name() {
            Some(name) => canonical_parent.join(name),
            None => canonical_parent,
        }
    };
    canonical_target
        .starts_with(&canonical_cwd)
        .then_some(canonical_target)
}

fn handle_fs_request(cwd: &Path, event: &Value) -> Value {
    let id = event.get("id").cloned().unwrap_or(Value::Null);
    let method = event.get("method").and_then(Value::as_str).unwrap_or("");
    let params = event.get("params").cloned().unwrap_or(Value::Null);
    let Some(path) = params.get("path").and_then(Value::as_str) else {
        return jsonrpc_error(id, -32602, "Missing path");
    };
    match method {
        "fs/read_text_file" => {
            let Some(resolved) = resolve_in_workspace(cwd, path, true) else {
                return jsonrpc_error(id, -32602, "Path is outside the workspace");
            };
            match std::fs::read_to_string(&resolved) {
                Ok(content) => {
                    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": content } })
                }
                Err(error) => jsonrpc_error(id, -32000, &format!("Cannot read file: {error}")),
            }
        }
        "fs/write_text_file" => {
            let Some(resolved) = resolve_in_workspace(cwd, path, false) else {
                return jsonrpc_error(id, -32602, "Path is outside the workspace");
            };
            let content = params.get("content").and_then(Value::as_str).unwrap_or("");
            match std::fs::write(&resolved, content) {
                Ok(()) => json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null }),
                Err(error) => jsonrpc_error(id, -32000, &format!("Cannot write file: {error}")),
            }
        }
        _ => jsonrpc_error(id, -32601, "Method not found"),
    }
}

async fn handle_agent_frame(
    inner: &Arc<AcpAgentManagerInner>,
    target: &RuntimeTarget,
    bridge: &PiRpcBridge,
    cwd: &Path,
    event: Value,
) {
    let method = event
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let has_id = event.get("id").is_some();
    match (method.as_deref(), has_id) {
        (Some("session/update"), false) => {
            let params = event.get("params").cloned().unwrap_or(Value::Null);
            broadcast_event(
                inner,
                target,
                json!({ "type": "acp_session_update", "params": params }),
            );
        }
        (Some(method), true) if method.starts_with("fs/") => {
            let reply = handle_fs_request(cwd, &event);
            let _ = bridge.send_frame(reply).await;
        }
        (Some("session/request_permission"), true) => {
            let id = event.get("id").cloned().unwrap_or(Value::Null);
            let request_key = format!("perm-{}", uuid::Uuid::new_v4().simple());
            if let Ok(mut pending) = inner.pending_permissions.lock() {
                pending.insert(format!("{}:{request_key}", target.instance_id), id);
            }
            let params = event.get("params").cloned().unwrap_or(Value::Null);
            broadcast_event(
                inner,
                target,
                json!({ "type": "acp_permission_request", "requestId": request_key, "params": params }),
            );
        }
        (Some(_), true) => {
            let id = event.get("id").cloned().unwrap_or(Value::Null);
            let _ = bridge
                .send_frame(jsonrpc_error(id, -32601, "Method not supported by Picot"))
                .await;
        }
        _ => {}
    }
}

fn broadcast_event(inner: &Arc<AcpAgentManagerInner>, target: &RuntimeTarget, event: Value) {
    let sequenced = {
        let Ok(mut coordinator) = inner.coordinator.lock() else {
            return;
        };
        coordinator.emit_event(target, event)
    };
    if let Ok(sequenced) = sequenced {
        let _ = inner.events.send(NativeRuntimeEvent {
            target: sequenced.target,
            sequence: sequenced.sequence,
            event: sequenced.event,
        });
    }
}

fn remove_closed_runtime(inner: &AcpAgentManagerInner, instance_id: &str) {
    let runtime = inner
        .runtimes
        .lock()
        .ok()
        .and_then(|mut runtimes| runtimes.remove(instance_id));
    let Some(mut runtime) = runtime else {
        return;
    };
    if let Some(process) = &mut runtime.process {
        let _ = process.kill();
    }
    let target = runtime.target.lock().ok().map(|target| target.clone());
    if let Some(target) = target {
        if let Ok(mut coordinator) = inner.coordinator.lock() {
            let _ = coordinator.unregister(&target);
        }
        if let Ok(mut pending) = inner.pending_permissions.lock() {
            let prefix = format!("{}:", target.instance_id);
            pending.retain(|key, _| !key.starts_with(&prefix));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_in_workspace, AcpAgentManager};
    use crate::acp_launch;
    use crate::runtime_coordinator::RuntimeTarget;

    /// Spawns the real `claude-agent-acp` CLI (network + local `claude` CLI
    /// auth required) and drives a full initialize/session-new/prompt round
    /// trip. Ignored by default so `cargo test`/CI stays offline and fast;
    /// run explicitly with `cargo test -- --ignored acp_manager` after
    /// confirming `npx -y @agentclientprotocol/claude-agent-acp` works
    /// locally (see acp_launch.rs's preset comment for the verified command).
    #[tokio::test]
    #[ignore]
    async fn spawns_and_prompts_the_real_claude_code_acp_agent() {
        let manager = AcpAgentManager::new();
        let target = RuntimeTarget::new("workspace-real", "session-real", "instance-real");
        let cwd = std::env::current_dir().unwrap();
        let spec = acp_launch::resolve_preset("claude-code", cwd).unwrap();

        let acp_session_id = manager.spawn(target.clone(), spec).await.unwrap();
        assert!(!acp_session_id.is_empty());
        assert!(manager.owns(&target));
        let mut events = manager.subscribe();

        let response = manager
            .request(
                &target,
                serde_json::json!({
                    "type": "acp_prompt",
                    "message": "Reply with exactly the single word PONG. Do not use any tools.",
                }),
                std::time::Duration::from_secs(60),
            )
            .await
            .unwrap();
        assert_eq!(response["stopReason"], "end_turn");

        let saw_message_chunk = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.event["type"] == "acp_session_update"
                    && event.event["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
                {
                    return true;
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(
            saw_message_chunk,
            "expected at least one acp_session_update/agent_message_chunk broadcast"
        );

        manager.stop(&target).unwrap();
        assert!(!manager.owns(&target));
    }

    #[test]
    fn owns_reports_false_for_an_unregistered_target() {
        let manager = AcpAgentManager::new();
        let target = RuntimeTarget::new("workspace-a", "session-a", "instance-a");
        assert!(!manager.owns(&target));
    }

    #[test]
    fn rejects_paths_that_escape_the_workspace_root() {
        let cwd = std::env::current_dir().unwrap();
        assert!(resolve_in_workspace(&cwd, "/etc/passwd", true).is_none());
        assert!(resolve_in_workspace(&cwd, "../../etc/passwd", false).is_none());
    }

    #[test]
    fn resolves_a_relative_path_inside_the_workspace() {
        let cwd = std::env::current_dir().unwrap();
        let resolved = resolve_in_workspace(&cwd, "Cargo.toml", true);
        assert_eq!(resolved, cwd.join("Cargo.toml").canonicalize().ok());
    }
}
