use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const PI_WEB_ORIGIN: &str = "http://127.0.0.1:8504";

#[derive(Debug, Deserialize)]
struct MachineCatalog {
    machines: Vec<Machine>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Machine {
    id: String,
    name: String,
    kind: String,
    status: Option<String>,
    status_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Project {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCatalog {
    workspaces: Vec<Workspace>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    project_id: String,
    path: String,
    label: String,
}

#[derive(Debug, Deserialize)]
struct PiWebSession {
    id: String,
    cwd: String,
    name: Option<String>,
    first_message: Option<String>,
    modified: String,
}

pub async fn discover_remote_sessions() -> Result<Value, String> {
    let client = pi_web_client()?;
    discover_remote_sessions_at(&client, PI_WEB_ORIGIN).await
}

pub async fn remote_session_get(
    machine_id: &str,
    session_id: &str,
    cwd: &str,
    resource: &str,
) -> Result<Value, String> {
    validate_remote_session_request(machine_id, session_id, cwd)?;
    let resource = match resource {
        "messages" | "status" | "stream-snapshot" | "models" | "thinking-levels" | "commands" => {
            resource
        }
        _ => return Err("Unsupported remote session resource".into()),
    };
    let client = pi_web_client()?;
    let mut url = remote_session_endpoint(machine_id, session_id, resource)?;
    url.query_pairs_mut().append_pair("cwd", cwd);
    get_json(&client, url.as_str()).await
}

pub async fn remote_session_post(
    machine_id: &str,
    session_id: &str,
    cwd: &str,
    action: &str,
    body: &Value,
) -> Result<Value, String> {
    validate_remote_session_request(machine_id, session_id, cwd)?;
    let action = match action {
        "prompt" | "abort" | "model" | "thinking-level" | "thinking-level/cycle" => action,
        _ => return Err("Unsupported remote session action".into()),
    };
    let client = pi_web_client()?;
    let mut payload = body.as_object().cloned().unwrap_or_default();
    payload.insert("cwd".into(), Value::String(cwd.to_owned()));
    let url = remote_session_endpoint(machine_id, session_id, action)?;
    client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("PI WEB is unavailable: {error}"))?
        .error_for_status()
        .map_err(|error| format!("PI WEB request failed: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("PI WEB returned invalid data: {error}"))
}

pub async fn create_remote_session(machine_id: &str, cwd: &str) -> Result<Value, String> {
    validate_remote_session_request(machine_id, "new", cwd)?;
    let client = pi_web_client_with_timeout(Duration::from_secs(30))?;
    let url = reqwest::Url::parse(&format!(
        "{PI_WEB_ORIGIN}/api/machines/{machine_id}/sessions"
    ))
    .map_err(|error| format!("Cannot build PI WEB session URL: {error}"))?;
    client
        .post(url)
        .json(&json!({ "cwd": cwd }))
        .send()
        .await
        .map_err(|error| format!("PI WEB is unavailable: {error}"))?
        .error_for_status()
        .map_err(|error| format!("PI WEB request failed: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("PI WEB returned invalid data: {error}"))
}

async fn discover_remote_sessions_at(client: &Client, origin: &str) -> Result<Value, String> {
    let catalog: MachineCatalog = get_json(client, &format!("{origin}/api/machines")).await?;
    let mut output = Vec::new();
    for machine in catalog
        .machines
        .into_iter()
        .filter(|machine| machine.kind == "remote")
    {
        match discover_machine(client, origin, &machine).await {
            Ok(value) => output.push(value),
            Err(error) => output.push(json!({
                "id": machine.id,
                "name": machine.name,
                "status": "error",
                "statusMessage": error,
                "sessions": [],
            })),
        }
    }
    Ok(json!({ "machines": output }))
}

async fn discover_machine(
    client: &Client,
    origin: &str,
    machine: &Machine,
) -> Result<Value, String> {
    let machine_id = &machine.id;
    let projects: Vec<Project> = get_json(
        client,
        &format!("{origin}/api/machines/{machine_id}/projects"),
    )
    .await?;
    let mut sessions = Vec::new();
    for project in projects {
        let project_id = &project.id;
        let catalog: WorkspaceCatalog = get_json(
            client,
            &format!("{origin}/api/machines/{machine_id}/projects/{project_id}/workspaces"),
        )
        .await?;
        for workspace in catalog.workspaces {
            let mut url =
                reqwest::Url::parse(&format!("{origin}/api/machines/{machine_id}/sessions"))
                    .map_err(|error| format!("Cannot build PI WEB session URL: {error}"))?;
            url.query_pairs_mut().append_pair("cwd", &workspace.path);
            let workspace_sessions: Vec<PiWebSession> = get_json(client, url.as_str()).await?;
            sessions.extend(workspace_sessions.into_iter().map(|session| json!({
                "id": session.id,
                "name": session.name,
                "firstMessage": session.first_message,
                "timestamp": session.modified,
                "projectPath": session.cwd,
                "projectName": if workspace.label.is_empty() { &project.name } else { &workspace.label },
                "machineId": machine.id,
                "machineName": machine.name,
                "projectId": workspace.project_id,
                "workspaceId": workspace.id,
                "remote": true,
            })));
        }
    }
    sessions.sort_by(|left, right| right["timestamp"].as_str().cmp(&left["timestamp"].as_str()));
    Ok(json!({
        "id": machine.id,
        "name": machine.name,
        "status": machine.status.as_deref().unwrap_or("online"),
        "statusMessage": machine.status_message,
        "sessions": sessions,
    }))
}

fn pi_web_client() -> Result<Client, String> {
    pi_web_client_with_timeout(Duration::from_secs(8))
}

fn pi_web_client_with_timeout(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Cannot create PI WEB client: {error}"))
}

fn remote_session_endpoint(
    machine_id: &str,
    session_id: &str,
    suffix: &str,
) -> Result<reqwest::Url, String> {
    reqwest::Url::parse(&format!(
        "{PI_WEB_ORIGIN}/api/machines/{machine_id}/sessions/{session_id}/{suffix}"
    ))
    .map_err(|error| format!("Cannot build PI WEB session URL: {error}"))
}

fn validate_remote_session_request(
    machine_id: &str,
    session_id: &str,
    cwd: &str,
) -> Result<(), String> {
    if !valid_id(machine_id) || !valid_id(session_id) {
        return Err("Invalid remote machine or session id".into());
    }
    if cwd.is_empty() || cwd.len() > 4096 || !cwd.starts_with('/') {
        return Err("Invalid remote session working directory".into());
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

async fn get_json<T: for<'de> Deserialize<'de>>(client: &Client, url: &str) -> Result<T, String> {
    client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("PI WEB is unavailable: {error}"))?
        .error_for_status()
        .map_err(|error| format!("PI WEB request failed: {error}"))?
        .json::<T>()
        .await
        .map_err(|error| format!("PI WEB returned invalid data: {error}"))
}
