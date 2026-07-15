#![cfg_attr(not(test), allow(dead_code))]

use serde_json::Value;
use std::collections::HashMap;

pub const PROTOCOL_VERSION: u64 = 2;

const REMOTE_FORBIDDEN_HOST_OPERATIONS: &[&str] = &[
    "pick_folder",
    "open_app",
    "install_package",
    "remove_package",
    "update_package",
    "check_for_updates",
    "install_update",
    "delete_workspace",
    "open_workspace",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientKind {
    Desktop,
    Remote,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RoutedAction {
    Runtime {
        client_id: String,
        request_id: String,
        frame: Value,
    },
    Host {
        client_id: String,
        request_id: String,
        operation: String,
        frame: Value,
    },
    Data {
        client_id: String,
        request_id: String,
        frame: Value,
    },
    Auth {
        client_id: String,
        request_id: String,
        frame: Value,
    },
    Subscribe {
        client_id: String,
        request_id: String,
        target: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterError {
    pub code: &'static str,
    pub message: String,
}

impl RouterError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct HostRouter {
    clients: HashMap<String, ClientKind>,
}

impl HostRouter {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    pub fn connect(&mut self, client_id: &str, hello: &Value) -> Result<(), RouterError> {
        if hello.get("type").and_then(Value::as_str) != Some("hello") {
            return Err(RouterError::new(
                "handshake_required",
                "First frame must be hello",
            ));
        }
        if hello.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            return Err(RouterError::new(
                "protocol_mismatch",
                format!(
                    "Picot protocol v{PROTOCOL_VERSION} is required; refresh or restart the app"
                ),
            ));
        }
        let kind = match hello.get("clientType").and_then(Value::as_str) {
            Some("desktop") => ClientKind::Desktop,
            Some("remote") => ClientKind::Remote,
            _ => {
                return Err(RouterError::new(
                    "invalid_client_type",
                    "Unsupported client type",
                ))
            }
        };
        if client_id.is_empty() {
            return Err(RouterError::new(
                "invalid_client_id",
                "clientId is required",
            ));
        }
        self.clients.insert(client_id.to_owned(), kind);
        Ok(())
    }

    pub fn client_kind(&self, client_id: &str) -> Option<ClientKind> {
        self.clients.get(client_id).copied()
    }

    pub fn route(&self, client_id: &str, frame: &Value) -> Result<RoutedAction, RouterError> {
        let client_kind = self.client_kind(client_id).ok_or_else(|| {
            RouterError::new("unauthorized_client", "Client has not completed handshake")
        })?;
        let frame_type = frame
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| RouterError::new("invalid_frame", "Frame type is required"))?;
        let request_id = frame
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RouterError::new("invalid_frame", "requestId is required"))?
            .to_owned();

        match frame_type {
            "runtime_subscribe" => {
                let target = frame.get("target").cloned().ok_or_else(|| {
                    RouterError::new("invalid_target", "Runtime target is required")
                })?;
                validate_target(&target)?;
                Ok(RoutedAction::Subscribe {
                    client_id: client_id.to_owned(),
                    request_id,
                    target,
                })
            }
            "runtime_request" | "runtime_snapshot_request" | "runtime_capabilities_request" => {
                if frame_type == "runtime_request" {
                    validate_runtime_request(frame)?;
                }
                Ok(RoutedAction::Runtime {
                    client_id: client_id.to_owned(),
                    request_id,
                    frame: frame.clone(),
                })
            }
            "host_request" => {
                let operation =
                    frame
                        .get("operation")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            RouterError::new("invalid_host_request", "operation is required")
                        })?;
                if client_kind == ClientKind::Remote
                    && REMOTE_FORBIDDEN_HOST_OPERATIONS.contains(&operation)
                {
                    return Err(RouterError::new(
                        "remote_operation_forbidden",
                        "Remote clients cannot invoke this Host operation",
                    ));
                }
                Ok(RoutedAction::Host {
                    client_id: client_id.to_owned(),
                    request_id,
                    operation: operation.to_owned(),
                    frame: frame.clone(),
                })
            }
            "data_request" => Ok(RoutedAction::Data {
                client_id: client_id.to_owned(),
                request_id,
                frame: frame.clone(),
            }),
            "auth_request" => Ok(RoutedAction::Auth {
                client_id: client_id.to_owned(),
                request_id,
                frame: frame.clone(),
            }),
            _ => Err(RouterError::new(
                "unknown_frame_type",
                "Unsupported protocol v2 frame type",
            )),
        }
    }
}

fn validate_runtime_request(frame: &Value) -> Result<(), RouterError> {
    let target = frame
        .get("target")
        .ok_or_else(|| RouterError::new("invalid_target", "Runtime target is required"))?;
    validate_target(target)?;
    let command_type = frame
        .get("command")
        .and_then(|command| command.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| RouterError::new("invalid_command", "Runtime command type is required"))?;
    if is_mutation(command_type)
        && frame
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .is_none()
    {
        return Err(RouterError::new(
            "idempotency_key_required",
            "Runtime mutations require idempotencyKey",
        ));
    }
    Ok(())
}

fn validate_target(target: &Value) -> Result<(), RouterError> {
    let target = target
        .as_object()
        .ok_or_else(|| RouterError::new("invalid_target", "Runtime target must be an object"))?;
    for field in ["workspaceId", "sessionId", "instanceId"] {
        if target.get(field).and_then(Value::as_str).is_none() {
            return Err(RouterError::new(
                "invalid_target",
                format!("{field} is required"),
            ));
        }
    }
    Ok(())
}

fn is_mutation(command_type: &str) -> bool {
    matches!(
        command_type,
        "prompt"
            | "steer"
            | "follow_up"
            | "compact"
            | "bash"
            | "fork"
            | "clone"
            | "navigate_tree"
            | "set_model"
            | "set_thinking_level"
            | "set_auto_compaction"
            | "set_auto_retry"
            | "set_steering_mode"
            | "set_follow_up_mode"
    )
}

#[cfg(test)]
mod tests {
    use super::{ClientKind, HostRouter, RoutedAction, PROTOCOL_VERSION};
    use serde_json::json;

    #[test]
    fn requires_an_exact_v2_handshake() {
        let mut router = HostRouter::new();
        assert!(router
            .connect(
                "client-a",
                &json!({ "type": "hello", "protocolVersion": 1, "clientType": "desktop" }),
            )
            .is_err());
        assert!(router
            .connect(
                "client-a",
                &json!({
                    "type": "hello",
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientType": "desktop",
                }),
            )
            .is_ok());
        assert_eq!(router.client_kind("client-a"), Some(ClientKind::Desktop));
    }

    #[test]
    fn keeps_runtime_and_host_routes_separate() {
        let mut router = HostRouter::new();
        router
            .connect(
                "desktop",
                &json!({ "type": "hello", "protocolVersion": 2, "clientType": "desktop" }),
            )
            .unwrap();
        let runtime = router
            .route(
                "desktop",
                &json!({
                    "type": "runtime_request",
                    "requestId": "request-1",
                    "idempotencyKey": "intent-1",
                    "target": {
                        "workspaceId": "workspace-a",
                        "sessionId": "session-a",
                        "instanceId": "instance-a"
                    },
                    "command": { "type": "prompt", "message": "secret" }
                }),
            )
            .unwrap();
        assert!(matches!(runtime, RoutedAction::Runtime { .. }));

        let host = router
            .route(
                "desktop",
                &json!({
                    "type": "host_request",
                    "requestId": "request-2",
                    "operation": "pick_folder"
                }),
            )
            .unwrap();
        assert!(matches!(host, RoutedAction::Host { .. }));
    }

    #[test]
    fn forbids_dangerous_host_operations_for_remote_clients() {
        let mut router = HostRouter::new();
        router
            .connect(
                "phone",
                &json!({ "type": "hello", "protocolVersion": 2, "clientType": "remote" }),
            )
            .unwrap();
        for operation in [
            "pick_folder",
            "open_app",
            "install_package",
            "check_for_updates",
            "delete_workspace",
        ] {
            assert!(router
                .route(
                    "phone",
                    &json!({
                        "type": "host_request",
                        "requestId": "request",
                        "operation": operation,
                    }),
                )
                .is_err());
        }
    }
}
