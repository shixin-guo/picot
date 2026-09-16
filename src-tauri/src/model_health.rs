// ABOUTME: L3 health check — verifies real connectivity to a model/provider
// ABOUTME: by shelling out to the bundled `pi` CLI with an isolated config dir.

use crate::pi_launch::PiLaunchResolver;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout as tokio_timeout;

/// Default hard timeout for a single model connectivity probe.
pub const DEFAULT_TEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct ModelTestRequest {
    pub provider_name: String,
    /// The provider config object as stored in models.json (baseUrl, api,
    /// apiKey, headers, compat, ...). `models` is overwritten with a single
    /// entry built from `model`.
    pub provider: Value,
    /// The model config object; must contain a non-empty string `id`.
    pub model: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTestOutcome {
    pub ok: bool,
    pub latency_ms: u64,
    pub stop_reason: Option<String>,
    pub response_text: Option<String>,
    pub error: Option<String>,
}

impl ModelTestOutcome {
    fn failure(latency_ms: u64, error: impl Into<String>) -> Self {
        Self {
            ok: false,
            latency_ms,
            stop_reason: None,
            response_text: None,
            error: Some(error.into()),
        }
    }
}

pub async fn run_model_test(
    pi_launch: &PiLaunchResolver,
    request: ModelTestRequest,
    timeout: Duration,
) -> Result<ModelTestOutcome, String> {
    let provider_name = request.provider_name.trim().to_string();
    if provider_name.is_empty() {
        return Err("providerName is required".to_string());
    }
    let model_id = request
        .model
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Model ID is required".to_string())?
        .to_string();

    let mut model_entry = request.model.clone();
    if let Some(object) = model_entry.as_object_mut() {
        object.insert("id".to_string(), Value::String(model_id.clone()));
    }

    let mut provider_entry = request.provider.clone();
    if !provider_entry.is_object() {
        provider_entry = json!({});
    }
    if let Some(object) = provider_entry.as_object_mut() {
        object.insert("models".to_string(), json!([model_entry]));
    }

    let models_json = json!({ "providers": { provider_name.clone(): provider_entry } });
    let settings_json = json!({ "retry": { "enabled": false } });

    let config_dir =
        std::env::temp_dir().join(format!("picot-model-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Cannot create temp config dir: {error}"))?;
    let cleanup = TempDirGuard(config_dir.clone());

    std::fs::write(
        config_dir.join("models.json"),
        serde_json::to_vec_pretty(&models_json).unwrap_or_default(),
    )
    .map_err(|error| format!("Cannot write models.json: {error}"))?;
    std::fs::write(
        config_dir.join("settings.json"),
        serde_json::to_vec_pretty(&settings_json).unwrap_or_default(),
    )
    .map_err(|error| format!("Cannot write settings.json: {error}"))?;

    let (pi_bin, path_env) = pi_launch.resolve_bundled_pi_for_spawn()?;

    let mut command = Command::new(&pi_bin);
    crate::windows_child::hide_console_tokio(&mut command);
    crate::appimage_env::scrub_tokio(&mut command);
    command
        .arg("--provider")
        .arg(&provider_name)
        .arg("--model")
        .arg(&model_id)
        .arg("--no-session")
        .arg("-p")
        .arg("Reply with OK only.")
        .arg("--mode")
        .arg("json")
        .env("PI_CODING_AGENT_DIR", &config_dir)
        .env("PATH", path_env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let started_at = Instant::now();
    let spawn_result = command.spawn();
    let child = match spawn_result {
        Ok(child) => child,
        Err(error) => {
            drop(cleanup);
            return Ok(ModelTestOutcome::failure(
                started_at.elapsed().as_millis() as u64,
                format!("Failed to launch pi: {error}"),
            ));
        }
    };

    let output = match tokio_timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            drop(cleanup);
            return Ok(ModelTestOutcome::failure(
                started_at.elapsed().as_millis() as u64,
                format!("pi process failed: {error}"),
            ));
        }
        Err(_) => {
            drop(cleanup);
            return Ok(ModelTestOutcome::failure(
                started_at.elapsed().as_millis() as u64,
                "Test timed out",
            ));
        }
    };
    let latency_ms = started_at.elapsed().as_millis() as u64;
    drop(cleanup);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    match parse_assistant_result(&stdout) {
        Some((stop_reason, text, error_message)) => {
            let ok = matches!(stop_reason.as_deref(), Some("stop" | "toolUse" | "length"));
            Ok(ModelTestOutcome {
                ok,
                latency_ms,
                stop_reason,
                response_text: text,
                error: if ok { None } else { error_message },
            })
        }
        None => {
            let details = if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else if !stdout.trim().is_empty() {
                stdout.trim().chars().take(500).collect()
            } else {
                format!("pi exited with {}", output.status)
            };
            Ok(ModelTestOutcome::failure(latency_ms, details))
        }
    }
}

/// Scan NDJSON `--mode json` output for the last assistant `message_end`
/// frame and extract `(stopReason, text, errorMessage)`.
fn parse_assistant_result(
    stdout: &str,
) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let mut result = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if frame.get("type").and_then(Value::as_str) != Some("message_end") {
            continue;
        }
        let Some(message) = frame.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let stop_reason = message
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let error_message = message
            .get("errorMessage")
            .and_then(Value::as_str)
            .map(str::to_string);
        let text = message
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .filter(|text| !text.is_empty());
        result = Some((stop_reason, text, error_message));
    }
    result
}

/// Best-effort recursive cleanup of the temp config dir, run on every exit
/// path (success, error, or timeout).
struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_successful_assistant_message() {
        let stdout = r#"
{"type":"agent_start"}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"OK"}]}}
{"type":"agent_settled"}
"#;
        let (stop_reason, text, error) = parse_assistant_result(stdout).expect("assistant frame");
        assert_eq!(stop_reason.as_deref(), Some("stop"));
        assert_eq!(text.as_deref(), Some("OK"));
        assert_eq!(error, None);
    }

    #[test]
    fn parses_error_assistant_message() {
        let stdout = r#"
{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"Connection error.","content":[]}}
{"type":"agent_settled"}
"#;
        let (stop_reason, text, error) = parse_assistant_result(stdout).expect("assistant frame");
        assert_eq!(stop_reason.as_deref(), Some("error"));
        assert_eq!(text, None);
        assert_eq!(error.as_deref(), Some("Connection error."));
    }

    #[test]
    fn returns_none_without_assistant_frame() {
        let stdout = r#"{"type":"agent_start"}"#;
        assert!(parse_assistant_result(stdout).is_none());
    }

    #[test]
    fn uses_last_assistant_frame_after_retries() {
        let stdout = r#"
{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"first"}}
{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"OK"}]}}
"#;
        let (stop_reason, text, _) = parse_assistant_result(stdout).expect("assistant frame");
        assert_eq!(stop_reason.as_deref(), Some("stop"));
        assert_eq!(text.as_deref(), Some("OK"));
    }
}
