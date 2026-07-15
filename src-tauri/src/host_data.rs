use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: FileKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub timestamp: String,
    pub name: Option<String>,
    pub first_message: Option<String>,
    pub workspace_id: String,
    pub file_name: String,
    pub modified_at_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchMatch {
    pub role: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub session_id: String,
    pub session_name: Option<String>,
    pub session_timestamp: String,
    pub first_message: Option<String>,
    pub file_name: String,
    pub matches: Vec<SessionSearchMatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostDashboardSummary {
    pub total_cost: f64,
    pub total_tokens: u64,
    pub session_count: u64,
    pub user_message_count: u64,
    pub avg_cost_per_session: f64,
    pub avg_cost_per_user_message: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdownEntry {
    pub name: String,
    pub cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSessionRow {
    pub id: String,
    pub title: String,
    pub model: String,
    pub time: String,
    pub total_cost: f64,
    pub total_tokens: u64,
    pub user_messages: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostDashboard {
    pub summary: CostDashboardSummary,
    pub by_model: Vec<CostBreakdownEntry>,
    pub by_tool: Vec<CostBreakdownEntry>,
    pub top_sessions: Vec<CostSessionRow>,
}

#[derive(Debug, Default)]
struct SessionMetrics {
    id: String,
    title: String,
    cwd: Option<PathBuf>,
    model: String,
    timestamp: String,
    total_cost: f64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    user_messages: u64,
    tool_cost_by_name: HashMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostDataError {
    UnknownWorkspace,
    InvalidRelativePath,
    OutsideWorkspace,
    NotDirectory,
    Io(String),
}

#[derive(Clone, Default)]
pub struct HostDataPlane {
    workspace_roots: HashMap<String, PathBuf>,
    session_root: Option<PathBuf>,
}

impl HostDataPlane {
    pub fn new(workspace_roots: HashMap<String, PathBuf>) -> Result<Self, HostDataError> {
        let mut canonical = HashMap::new();
        for (workspace_id, root) in workspace_roots {
            let root = root
                .canonicalize()
                .map_err(|error| HostDataError::Io(error.to_string()))?;
            canonical.insert(workspace_id, root);
        }
        Ok(Self {
            workspace_roots: canonical,
            session_root: None,
        })
    }

    pub fn with_session_root(mut self, session_root: PathBuf) -> Self {
        self.session_root = Some(session_root);
        self
    }

    pub fn list_files(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<Vec<FileEntry>, HostDataError> {
        let root = self
            .workspace_roots
            .get(workspace_id)
            .ok_or(HostDataError::UnknownWorkspace)?;
        let requested = safe_join(root, relative_path)?;
        if !requested.is_dir() {
            return Err(HostDataError::NotDirectory);
        }
        let mut entries = std::fs::read_dir(&requested)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                let kind = if file_type.is_dir() {
                    FileKind::Directory
                } else if file_type.is_file() {
                    FileKind::File
                } else {
                    return None;
                };
                let path = entry.path();
                let relative = path.strip_prefix(root).ok()?;
                Some(FileEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    relative_path: relative.to_string_lossy().replace('\\', "/"),
                    kind,
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            let left_directory = left.kind == FileKind::Directory;
            let right_directory = right.kind == FileKind::Directory;
            right_directory
                .cmp(&left_directory)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub fn list_sessions(&self, workspace_id: &str) -> Result<Vec<SessionSummary>, HostDataError> {
        let workspace = self
            .workspace_roots
            .get(workspace_id)
            .ok_or(HostDataError::UnknownWorkspace)?;
        let Some(session_root) = &self.session_root else {
            return Ok(Vec::new());
        };
        if !session_root.is_dir() {
            return Ok(Vec::new());
        }
        let mut sessions = Vec::new();
        for project in std::fs::read_dir(session_root)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
        {
            if !project.path().is_dir() {
                continue;
            }
            for file in std::fs::read_dir(project.path())
                .map_err(|error| HostDataError::Io(error.to_string()))?
                .filter_map(Result::ok)
            {
                let path = file.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(summary) = parse_session_summary(&path, workspace_id, workspace)? {
                    sessions.push(summary);
                }
            }
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at_ms));
        Ok(sessions)
    }

    pub fn search_sessions(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<Vec<SessionSearchResult>, HostDataError> {
        const MAX_RESULTS: usize = 30;
        let workspace = self
            .workspace_roots
            .get(workspace_id)
            .ok_or(HostDataError::UnknownWorkspace)?;
        let Some(session_root) = &self.session_root else {
            return Ok(Vec::new());
        };
        let query = query.trim().to_lowercase();
        if query.len() < 2 || !session_root.is_dir() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for project in std::fs::read_dir(session_root)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
        {
            if !project.path().is_dir() {
                continue;
            }
            for file in std::fs::read_dir(project.path())
                .map_err(|error| HostDataError::Io(error.to_string()))?
                .filter_map(Result::ok)
            {
                if results.len() >= MAX_RESULTS {
                    return Ok(results);
                }
                let path = file.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(result) = search_session_file(&path, workspace, &query)? {
                    results.push(result);
                }
            }
        }
        Ok(results)
    }

    pub fn cost_dashboard(&self, workspace_id: &str) -> Result<CostDashboard, HostDataError> {
        let workspace = self
            .workspace_roots
            .get(workspace_id)
            .ok_or(HostDataError::UnknownWorkspace)?;
        let Some(session_root) = &self.session_root else {
            return Ok(CostDashboard::default());
        };
        if !session_root.is_dir() {
            return Ok(CostDashboard::default());
        }
        let mut sessions = Vec::new();
        for project in std::fs::read_dir(session_root)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
        {
            if !project.path().is_dir() {
                continue;
            }
            for file in std::fs::read_dir(project.path())
                .map_err(|error| HostDataError::Io(error.to_string()))?
                .filter_map(Result::ok)
            {
                let path = file.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(metrics) = parse_session_metrics(&path, workspace)? {
                    sessions.push(metrics);
                }
            }
        }
        Ok(build_cost_dashboard(sessions))
    }
}

fn find_chars(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn search_session_file(
    path: &Path,
    workspace: &Path,
    query: &str,
) -> Result<Option<SessionSearchResult>, HostDataError> {
    const MAX_MATCHES_PER_SESSION: usize = 3;
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut session_id = None;
    let mut session_timestamp = String::new();
    let mut session_name = None;
    let mut first_message = None;
    let mut cwd = None;
    let mut matches = Vec::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(serde_json::Value::as_str) {
            Some("session") => {
                session_id = entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                session_timestamp = entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from);
            }
            Some("session_info") => {
                session_name = entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
            }
            Some("message") => {
                let role = entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned();
                let Some(text) = message_text(entry.pointer("/message/content")) else {
                    continue;
                };
                if role == "user" && first_message.is_none() {
                    first_message = Some(text.chars().take(120).collect::<String>());
                }
                if matches.len() >= MAX_MATCHES_PER_SESSION {
                    continue;
                }
                let lower: Vec<char> = text.to_lowercase().chars().collect();
                let needle: Vec<char> = query.chars().collect();
                if let Some(index) = find_chars(&lower, &needle) {
                    let original: Vec<char> = text.chars().collect();
                    let start = index.saturating_sub(60);
                    let end = (index + needle.len() + 60).min(original.len());
                    let snippet: String = original[start..end].iter().collect();
                    let snippet = format!(
                        "{}{}{}",
                        if start > 0 { "…" } else { "" },
                        snippet.replace('\n', " "),
                        if end < original.len() { "…" } else { "" }
                    );
                    matches.push(SessionSearchMatch { role, snippet });
                }
            }
            _ => {}
        }
    }
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let Some(cwd) = cwd.and_then(|cwd| cwd.canonicalize().ok()) else {
        return Ok(None);
    };
    if cwd != workspace || matches.is_empty() {
        return Ok(None);
    }
    Ok(Some(SessionSearchResult {
        session_id,
        session_name,
        session_timestamp,
        first_message,
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        matches,
    }))
}

fn parse_session_metrics(
    path: &Path,
    workspace: &Path,
) -> Result<Option<SessionMetrics>, HostDataError> {
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut metrics = SessionMetrics {
        model: "unknown".to_owned(),
        ..SessionMetrics::default()
    };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(serde_json::Value::as_str) {
            Some("session") => {
                metrics.id = entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                metrics.timestamp = entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                metrics.cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from);
            }
            Some("session_info") => {
                if let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) {
                    metrics.title = name.to_owned();
                }
            }
            Some("model_change") => {
                if let Some(model) = entry.get("model").and_then(serde_json::Value::as_str) {
                    metrics.model = model.to_owned();
                }
            }
            Some("message") => {
                let Some(role) = entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                else {
                    continue;
                };
                if role == "user" {
                    metrics.user_messages += 1;
                    continue;
                }
                if role != "assistant" {
                    continue;
                }
                if let Some(model) = entry
                    .pointer("/message/model")
                    .and_then(serde_json::Value::as_str)
                {
                    metrics.model = model.to_owned();
                }
                let usage = entry.pointer("/message/usage");
                let cost = usage
                    .and_then(|usage| usage.pointer("/cost/total"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                metrics.total_cost += cost;
                metrics.input_tokens += usage
                    .and_then(|usage| usage.get("input"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                metrics.output_tokens += usage
                    .and_then(|usage| usage.get("output"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                metrics.cache_read += usage
                    .and_then(|usage| usage.get("cacheRead"))
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let tool_calls: Vec<&str> = entry
                    .pointer("/message/content")
                    .and_then(serde_json::Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter(|block| {
                                block.get("type").and_then(serde_json::Value::as_str)
                                    == Some("toolCall")
                            })
                            .filter_map(|block| {
                                block.get("name").and_then(serde_json::Value::as_str)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !tool_calls.is_empty() && cost > 0.0 {
                    let per_tool_cost = cost / tool_calls.len() as f64;
                    for tool_name in tool_calls {
                        *metrics
                            .tool_cost_by_name
                            .entry(tool_name.to_owned())
                            .or_insert(0.0) += per_tool_cost;
                    }
                }
            }
            _ => {}
        }
    }
    if metrics.id.is_empty() {
        return Ok(None);
    }
    let Some(cwd) = metrics.cwd.as_ref().and_then(|cwd| cwd.canonicalize().ok()) else {
        return Ok(None);
    };
    if cwd != workspace {
        return Ok(None);
    }
    if metrics.title.is_empty() {
        metrics.title = "Untitled".to_owned();
    }
    Ok(Some(metrics))
}

fn build_cost_dashboard(sessions: Vec<SessionMetrics>) -> CostDashboard {
    let mut dashboard = CostDashboard::default();
    let mut by_model: Vec<(String, f64)> = Vec::new();
    let mut by_tool: HashMap<String, f64> = HashMap::new();
    for session in &sessions {
        dashboard.summary.total_cost += session.total_cost;
        let session_tokens = session.input_tokens + session.output_tokens + session.cache_read;
        dashboard.summary.total_tokens += session_tokens;
        dashboard.summary.user_message_count += session.user_messages;
        dashboard.summary.session_count += 1;

        match by_model.iter_mut().find(|(name, _)| name == &session.model) {
            Some((_, cost)) => *cost += session.total_cost,
            None => by_model.push((session.model.clone(), session.total_cost)),
        }
        for (tool_name, cost) in &session.tool_cost_by_name {
            *by_tool.entry(tool_name.clone()).or_insert(0.0) += cost;
        }
    }
    dashboard.summary.avg_cost_per_session = if dashboard.summary.session_count > 0 {
        dashboard.summary.total_cost / dashboard.summary.session_count as f64
    } else {
        0.0
    };
    dashboard.summary.avg_cost_per_user_message = if dashboard.summary.user_message_count > 0 {
        dashboard.summary.total_cost / dashboard.summary.user_message_count as f64
    } else {
        0.0
    };
    by_model.sort_by(|left, right| right.1.total_cmp(&left.1));
    dashboard.by_model = by_model
        .into_iter()
        .map(|(name, cost)| CostBreakdownEntry { name, cost })
        .collect();
    let mut by_tool: Vec<(String, f64)> = by_tool.into_iter().collect();
    by_tool.sort_by(|left, right| right.1.total_cmp(&left.1));
    dashboard.by_tool = by_tool
        .into_iter()
        .map(|(name, cost)| CostBreakdownEntry { name, cost })
        .collect();

    let mut top_sessions: Vec<CostSessionRow> = sessions
        .into_iter()
        .map(|session| CostSessionRow {
            id: session.id,
            title: session.title,
            model: session.model,
            time: session.timestamp,
            total_cost: session.total_cost,
            total_tokens: session.input_tokens + session.output_tokens + session.cache_read,
            user_messages: session.user_messages,
        })
        .collect();
    top_sessions.sort_by(|left, right| right.total_cost.total_cmp(&left.total_cost));
    top_sessions.truncate(20);
    dashboard.top_sessions = top_sessions;
    dashboard
}

fn parse_session_summary(
    path: &Path,
    workspace_id: &str,
    workspace: &Path,
) -> Result<Option<SessionSummary>, HostDataError> {
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let mut id = None;
    let mut timestamp = String::new();
    let mut cwd = None;
    let mut name = None;
    let mut first_message = None;
    let mut user_message_count = 0;
    let mut line_count = 0;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        line_count += 1;
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(serde_json::Value::as_str) {
            Some("session") => {
                id = entry
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                timestamp = entry
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                cwd = entry
                    .get("cwd")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from);
            }
            Some("session_info") => {
                name = entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
            }
            Some("message")
                if entry
                    .pointer("/message/role")
                    .and_then(serde_json::Value::as_str)
                    == Some("user") =>
            {
                user_message_count += 1;
                if first_message.is_none() {
                    first_message = message_text(entry.pointer("/message/content"))
                        .map(|text| text.chars().take(120).collect());
                }
            }
            _ => {}
        }
        if line_count > 50 && first_message.is_some() {
            break;
        }
    }
    let Some(id) = id else { return Ok(None) };
    if user_message_count == 0 && line_count <= 4 {
        return Ok(None);
    }
    let Some(cwd) = cwd.and_then(|cwd| cwd.canonicalize().ok()) else {
        return Ok(None);
    };
    if cwd != workspace {
        return Ok(None);
    }
    let metadata = std::fs::metadata(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis());
    Ok(Some(SessionSummary {
        id,
        timestamp,
        name,
        first_message,
        workspace_id: workspace_id.to_owned(),
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        modified_at_ms,
    }))
}

fn message_text(content: Option<&serde_json::Value>) -> Option<String> {
    match content? {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .find(|block| block.get("type").and_then(serde_json::Value::as_str) == Some("text"))
            .and_then(|block| block.get("text"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

fn safe_join(root: &Path, relative_path: &str) -> Result<PathBuf, HostDataError> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(HostDataError::InvalidRelativePath);
    }
    let joined = root.join(relative);
    let canonical = joined
        .canonicalize()
        .map_err(|error| HostDataError::Io(error.to_string()))?;
    if !canonical.starts_with(root) {
        return Err(HostDataError::OutsideWorkspace);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::{FileKind, HostDataError, HostDataPlane};
    use std::collections::HashMap;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn lists_registered_workspace_files_and_rejects_escape_paths() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-data-{nonce}"));
        let workspace = temp.join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("README.md"), "read me").unwrap();
        fs::write(temp.join("secret.txt"), "secret").unwrap();
        let data =
            HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace.clone())])).unwrap();

        let entries = data.list_files("workspace-a", "").unwrap();
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[0].kind, FileKind::Directory);
        assert_eq!(entries[1].relative_path, "README.md");
        assert_eq!(
            data.list_files("workspace-a", "../"),
            Err(HostDataError::InvalidRelativePath)
        );
        assert_eq!(
            data.list_files("missing", ""),
            Err(HostDataError::UnknownWorkspace)
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_resolve_outside_the_workspace() {
        use std::os::unix::fs::symlink;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-data-link-{nonce}"));
        let workspace = temp.join("workspace");
        let outside = temp.join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, workspace.join("escape")).unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)])).unwrap();
        assert_eq!(
            data.list_files("workspace-a", "escape"),
            Err(HostDataError::OutsideWorkspace)
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn lists_only_sessions_owned_by_the_registered_workspace_and_skips_unknown_entries() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-sessions-{nonce}"));
        let workspace = temp.join("workspace");
        let other = temp.join("other");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("included.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"future_entry\",\"payload\":true}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello from session\"}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("excluded.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"private\"}}}}\n",
                serde_json::to_string(&other.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let listed = data.list_sessions("workspace-a").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "session-a");
        assert_eq!(
            listed[0].first_message.as_deref(),
            Some("hello from session")
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn searches_only_the_registered_workspace_and_returns_snippets() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-search-{nonce}"));
        let workspace = temp.join("workspace");
        let other = temp.join("other");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("included.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"please refactor the widget factory\"}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("excluded.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"refactor this too\"}}}}\n",
                serde_json::to_string(&other.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let results = data.search_sessions("workspace-a", "widget").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].session_id, "session-a");
        assert!(results[0].matches[0].snippet.contains("widget"));

        assert!(
            data.search_sessions("workspace-a", "refactor")
                .unwrap()
                .len()
                == 1
        );
        assert!(data.search_sessions("missing", "widget").is_err());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn builds_cost_dashboard_scoped_to_the_registered_workspace() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-cost-{nonce}"));
        let workspace = temp.join("workspace");
        let other = temp.join("other");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("included.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"model\":\"gpt-5\",\"usage\":{{\"input\":10,\"output\":20,\"cost\":{{\"total\":0.5}}}},\"content\":[{{\"type\":\"toolCall\",\"name\":\"bash\"}}]}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("excluded.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-b\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"model\":\"gpt-5\",\"usage\":{{\"cost\":{{\"total\":99.0}}}}}}}}\n",
                serde_json::to_string(&other.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let dashboard = data.cost_dashboard("workspace-a").unwrap();
        assert_eq!(dashboard.summary.session_count, 1);
        assert_eq!(dashboard.summary.total_cost, 0.5);
        assert_eq!(dashboard.summary.total_tokens, 30);
        assert_eq!(dashboard.by_model[0].name, "gpt-5");
        assert_eq!(dashboard.by_tool[0].name, "bash");
        assert_eq!(dashboard.top_sessions[0].id, "session-a");
        fs::remove_dir_all(temp).unwrap();
    }
}
