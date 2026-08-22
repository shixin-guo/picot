#![cfg_attr(not(test), allow(dead_code))]

// Executes scheduled tasks: a workspace + prompt + cadence + optional model
// that Picot runs headlessly (no webview watching), producing a normal Picot
// session the user can open afterwards.
//
// Deliberately simple per product spec:
//   - no cron parser, just once/hourly/daily/weekly anchored at a timestamp
//     (see `metadata_store::advance_next_run_at`)
//   - no background retry loop: a failed run just becomes `status=failed`
//     with `retry_count` incremented; only a one-time startup catch-up pass
//     retries it (capped), plus a manual "run now" endpoint that always
//     works and resets the counter.
//
// Completion detection has no frontend watching the RPC event stream, so
// this module pumps `NativePiManager`'s broadcast events itself, mirroring
// the `agent_start` / `message_end` / `agent_settled` pattern the frontend
// normally reacts to (see `public/native/app.js` `handleRuntimeEvent` and
// `model_health.rs`'s `parse_assistant_result` for the same stopReason
// convention over a non-streaming pi invocation).

use crate::host_data::HostDataPlane;
use crate::metadata_store::{MetadataStore, ScheduledTask};
use crate::native_pi_manager::NativePiManager;
use crate::pi_launch::PiLaunchResolver;
use crate::runtime_coordinator::RuntimeTarget;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::broadcast;

/// Scheduler tick interval — a `tokio::spawn` loop, not an external cron.
const TICK_INTERVAL: Duration = Duration::from_secs(60);
/// After a failed run is retried this many times by the startup catch-up
/// pass, it is left `failed` for the user to see/manually retry.
pub const RETRY_CAP: i64 = 3;
/// Hard ceiling on how long a headless scheduled run may take before the
/// scheduler gives up and marks it failed.
const RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone)]
pub struct SchedulerDeps {
    pub metadata: Arc<Mutex<MetadataStore>>,
    pub data: HostDataPlane,
    pub pi_launch: PiLaunchResolver,
    pub runtimes: NativePiManager,
    pub app_handle: Option<AppHandle>,
}

/// Start the scheduler: run the one-time startup catch-up pass, then tick
/// every `TICK_INTERVAL` polling for newly-due tasks. Runs for the lifetime
/// of the app inside Tauri's async runtime.
pub fn spawn(deps: SchedulerDeps) {
    tauri::async_runtime::spawn(async move {
        run_catch_up(&deps).await;
        loop {
            tokio::time::sleep(TICK_INTERVAL).await;
            run_due(&deps).await;
        }
    });
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn run_catch_up(deps: &SchedulerDeps) {
    let tasks = {
        let Ok(store) = deps.metadata.lock() else {
            return;
        };
        store.catch_up_scheduled_tasks(now_unix(), RETRY_CAP).unwrap_or_default()
    };
    for task in tasks {
        execute_task(deps, task).await;
    }
}

async fn run_due(deps: &SchedulerDeps) {
    let tasks = {
        let Ok(store) = deps.metadata.lock() else {
            return;
        };
        store.due_scheduled_tasks(now_unix()).unwrap_or_default()
    };
    for task in tasks {
        execute_task(deps, task).await;
    }
}

/// Run one scheduled task to completion (or failure) and record the
/// outcome. Shared by the catch-up pass, the periodic tick, and the manual
/// "run now" HTTP endpoint — the latter calls this directly after resetting
/// `retry_count`, bypassing the due/catch-up selection entirely.
pub async fn execute_task(deps: &SchedulerDeps, task: ScheduledTask) {
    if let Ok(mut store) = deps.metadata.lock() {
        let _ = store.mark_scheduled_task_running(&task.id);
    }

    let outcome = run_task(deps, &task).await;
    let (success, session_id, error_message) = match outcome {
        Ok(session_id) => (true, session_id, None),
        Err(message) => (false, None, Some(message)),
    };

    if let Ok(mut store) = deps.metadata.lock() {
        let _ =
            store.mark_scheduled_task_finished(&task.id, success, session_id.as_deref());
    }

    notify_completion(deps, &task, success, session_id, error_message);
}

async fn run_task(deps: &SchedulerDeps, task: &ScheduledTask) -> Result<Option<String>, String> {
    let cwd = deps
        .data
        .workspace_root_path(&task.workspace_id)
        .map_err(|error| format!("Cannot resolve scheduled task workspace: {error:?}"))?;
    let cwd_str = cwd.to_string_lossy().into_owned();
    let launch = deps
        .pi_launch
        .native_launch_spec(&cwd_str, None)
        .map_err(|error| format!("Cannot build launch spec: {error}"))?;

    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let instance_id = format!("instance-{}", uuid::Uuid::new_v4().simple());
    let mut target = RuntimeTarget::new(task.workspace_id.clone(), session_id, instance_id);

    // Subscribe before spawning so the very first `agent_start` can never
    // race ahead of the receiver.
    let events = deps.runtimes.subscribe();

    deps.runtimes
        .spawn(target.clone(), launch)
        .map_err(|error| format!("Cannot spawn runtime: {error}"))?;

    let result = drive_task(deps, &mut target, task, events).await;
    let _ = deps.runtimes.stop(&target);
    result
}

async fn drive_task(
    deps: &SchedulerDeps,
    target: &mut RuntimeTarget,
    task: &ScheduledTask,
    events: broadcast::Receiver<crate::native_pi_manager::NativeRuntimeEvent>,
) -> Result<Option<String>, String> {
    if let Some(model) = &task.model {
        deps.runtimes
            .request(
                target,
                serde_json::json!({ "type": "set_model", "modelId": model }),
                Some(&uuid::Uuid::new_v4().to_string()),
                Duration::from_secs(30),
            )
            .await
            .map_err(|error| format!("Cannot set model {model}: {error}"))?;
    }

    deps.runtimes
        .request(
            target,
            serde_json::json!({ "type": "prompt", "message": task.prompt }),
            Some(&uuid::Uuid::new_v4().to_string()),
            Duration::from_secs(30),
        )
        .await
        .map_err(|error| format!("Cannot send scheduled prompt: {error}"))?;

    wait_for_turn_completion(events, target, RUN_TIMEOUT).await?;

    // Resolve the formal (saved) session id the same way the WS
    // `runtime_snapshot_request` handler does in `host_server.rs`: ask the
    // runtime for its state and bind the temporary id once pi has assigned
    // a real one.
    let state_response = deps
        .runtimes
        .request(
            target,
            serde_json::json!({ "type": "get_state" }),
            None,
            Duration::from_secs(10),
        )
        .await
        .map_err(|error| format!("Cannot read session state: {error}"))?;
    if target.session_id.starts_with("temporary-") {
        if let Some(formal_session_id) = state_response
            .pointer("/data/sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            *target = deps
                .runtimes
                .bind_session_id(target, formal_session_id)
                .map_err(|error| format!("Cannot bind session id: {error}"))?;
        }
    }

    Ok(Some(target.session_id.clone()))
}

/// Watch the runtime event stream for `target` until the turn settles,
/// mirroring `public/native/app.js`'s `handleRuntimeEvent` (`agent_settled`
/// = turn done) and `model_health.rs`'s stop-reason convention for success
/// vs failure (`stop`/`toolUse`/`length` = ok, anything else = error).
async fn wait_for_turn_completion(
    mut events: broadcast::Receiver<crate::native_pi_manager::NativeRuntimeEvent>,
    target: &RuntimeTarget,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_error: Option<String> = None;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("Scheduled task timed out waiting for the turn to finish".to_string());
        }
        let event = match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Ok(event)) => event,
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(broadcast::error::RecvError::Closed)) => {
                return Err("Runtime stopped before the scheduled task finished".to_string());
            }
            Err(_) => {
                return Err("Scheduled task timed out waiting for the turn to finish".to_string())
            }
        };
        if event.target.instance_id != target.instance_id {
            continue;
        }
        match event.event.get("type").and_then(Value::as_str) {
            Some("message_end") => {
                if event.event.pointer("/message/role").and_then(Value::as_str) == Some("assistant")
                {
                    let stop_reason = event
                        .event
                        .pointer("/message/stopReason")
                        .and_then(Value::as_str);
                    last_error = if matches!(stop_reason, Some("stop" | "toolUse" | "length")) {
                        None
                    } else {
                        Some(
                            event
                                .event
                                .pointer("/message/errorMessage")
                                .and_then(Value::as_str)
                                .unwrap_or("The agent turn ended with an error")
                                .to_string(),
                        )
                    };
                }
            }
            Some("agent_settled") | Some("agent_end") => {
                return match last_error {
                    Some(message) => Err(message),
                    None => Ok(()),
                };
            }
            Some("protocol_error") => {
                return Err(event
                    .event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Pi protocol error")
                    .to_string());
            }
            _ => {}
        }
    }
}

fn notify_completion(
    deps: &SchedulerDeps,
    task: &ScheduledTask,
    success: bool,
    session_id: Option<String>,
    error_message: Option<String>,
) {
    let Some(app) = &deps.app_handle else {
        return;
    };
    let Some(session_id) = session_id.or_else(|| task.last_session_id.clone()) else {
        // Nothing to open (spawn/set-up failed before a session existed);
        // still worth a heads-up notification, just without a click target.
        return notify_without_target(app, task, success, error_message);
    };
    let Ok(cwd) = deps.data.workspace_root_path(&task.workspace_id) else {
        return;
    };
    let title = if success {
        "Scheduled task completed"
    } else {
        "Scheduled task failed"
    };
    let preview = prompt_preview(&task.prompt);
    let body = if success {
        format!("\"{preview}\" finished successfully.")
    } else {
        format!(
            "\"{preview}\" failed{}.",
            error_message.map(|m| format!(": {m}")).unwrap_or_default()
        )
    };
    if let Err(error) =
        crate::show_completion_notification(app, title, &body, cwd, session_id)
    {
        log::error!("[picot-scheduler] failed to show notification: {error}");
    }
}

fn notify_without_target(
    app: &AppHandle,
    task: &ScheduledTask,
    success: bool,
    error_message: Option<String>,
) {
    let title = if success {
        "Scheduled task completed"
    } else {
        "Scheduled task failed"
    };
    let preview = prompt_preview(&task.prompt);
    let body = if success {
        format!("\"{preview}\" finished successfully.")
    } else {
        format!(
            "\"{preview}\" failed{}.",
            error_message.map(|m| format!(": {m}")).unwrap_or_default()
        )
    };
    #[cfg(target_os = "macos")]
    let _ = notify_rust::set_application(&app.config().identifier);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    if let Err(error) = notify_rust::Notification::new()
        .summary(title)
        .body(&body)
        .show()
    {
        log::error!("[picot-scheduler] failed to show notification: {error}");
    }
}

fn prompt_preview(prompt: &str) -> String {
    const MAX_LEN: usize = 80;
    let trimmed = prompt.trim();
    if trimmed.chars().count() <= MAX_LEN {
        return trimmed.to_string();
    }
    let truncated: String = trimmed.chars().take(MAX_LEN).collect();
    format!("{truncated}…")
}
