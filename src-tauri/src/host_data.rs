use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone)]
struct CachedSessionSummary {
    modified_at_ms: u128,
    len: u64,
    summary: Option<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub git_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: FileKind,
    /// Byte size of the file; `None` for directories or when metadata is unavailable.
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub timestamp: String,
    pub name: Option<String>,
    pub first_message: Option<String>,
    pub workspace_id: String,
    /// Absolute working directory the session was created in (its "project").
    pub project_path: String,
    /// Human-friendly project label (last path component of `project_path`).
    pub project_name: String,
    /// True when this session belongs to the workspace the sidebar is showing.
    pub is_current_workspace: bool,
    pub file_name: String,
    pub modified_at_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Directory,
}

/// Result of a best-effort batch delete: each requested session id lands in
/// exactly one of `deleted` / `errors` (ids that don't resolve to a session
/// file on disk count as errors too, mirroring "not found").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionsResult {
    pub deleted: Vec<String>,
    pub errors: Vec<String>,
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
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub tool_calls: u64,
    pub tool_cost_by_name: HashMap<String, f64>,
    pub user_messages: u64,
    pub project_path: String,
    pub project_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostDashboard {
    pub summary: CostDashboardSummary,
    pub by_model: Vec<CostBreakdownEntry>,
    pub by_tool: Vec<CostBreakdownEntry>,
    pub top_sessions: Vec<CostSessionRow>,
    pub sessions: Vec<CostSessionRow>,
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
    cache_write: u64,
    user_messages: u64,
    tool_calls: u64,
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
    workspace_roots: Arc<RwLock<HashMap<String, PathBuf>>>,
    session_root: Option<PathBuf>,
    session_summary_cache: Arc<RwLock<HashMap<PathBuf, CachedSessionSummary>>>,
}

fn message_with_entry_id(mut message: serde_json::Value, entry_id: &str) -> serde_json::Value {
    if message.get("role").and_then(serde_json::Value::as_str) != Some("user") {
        return message;
    }
    if let Some(object) = message.as_object_mut() {
        object.insert(
            "entryId".to_owned(),
            serde_json::Value::String(entry_id.to_owned()),
        );
    }
    message
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
            workspace_roots: Arc::new(RwLock::new(canonical)),
            session_root: None,
            session_summary_cache: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub fn with_session_root(mut self, session_root: PathBuf) -> Self {
        self.session_root = Some(session_root);
        self
    }

    /// Register (or update) a workspace root at runtime. Used when the user
    /// opens a new folder as a workspace after startup.
    pub fn register_workspace(
        &self,
        workspace_id: &str,
        root: PathBuf,
    ) -> Result<(), HostDataError> {
        let root = root
            .canonicalize()
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        self.workspace_roots
            .write()
            .map_err(|_| HostDataError::Io("workspace registry poisoned".into()))?
            .insert(workspace_id.to_string(), root);
        Ok(())
    }

    fn workspace_root(&self, workspace_id: &str) -> Result<PathBuf, HostDataError> {
        self.workspace_roots
            .read()
            .map_err(|_| HostDataError::Io("workspace registry poisoned".into()))?
            .get(workspace_id)
            .cloned()
            .ok_or(HostDataError::UnknownWorkspace)
    }

    pub fn list_files(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<Vec<FileEntry>, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let root = root.as_path();
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
                // Read size cheaply via the already-open DirEntry metadata.
                let size = if kind == FileKind::File {
                    entry.metadata().ok().map(|m| m.len())
                } else {
                    None
                };
                let path = entry.path();
                let relative = path.strip_prefix(root).ok()?;
                Some(FileEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    relative_path: relative.to_string_lossy().replace('\\', "/"),
                    kind,
                    size,
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

    /// Return the registered filesystem root (working directory) for a
    /// workspace, so a runtime can be lazily resumed with the correct cwd.
    pub fn workspace_root_path(&self, workspace_id: &str) -> Result<PathBuf, HostDataError> {
        self.workspace_root(workspace_id)
    }

    /// Return the workspace path and its current git branch (if any).
    pub fn workspace_info(&self, workspace_id: &str) -> Result<WorkspaceInfo, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let path = root.to_string_lossy().into_owned();
        let git_branch = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty() && s != "HEAD");
        Ok(WorkspaceInfo { path, git_branch })
    }

    /// Resolve the on-disk session file for a saved session that belongs to a
    /// workspace. Used to lazily resume a runtime when a historical session is
    /// opened from the sidebar and no live runtime exists for it yet.
    pub fn resolve_session_path(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Option<PathBuf>, HostDataError> {
        let workspace = self.workspace_root(workspace_id)?;
        let workspace = workspace.as_path();
        let Some(session_root) = &self.session_root else {
            return Ok(None);
        };
        if !session_root.is_dir() {
            return Ok(None);
        }
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
                let Some(summary) = parse_session_summary(&path)? else {
                    continue;
                };
                if summary.id == session_id && same_dir(workspace, Path::new(&summary.project_path))
                {
                    return Ok(Some(path));
                }
            }
        }
        Ok(None)
    }

    /// Read session messages directly from the on-disk JSONL file, bypassing
    /// the Pi runtime process. Returns messages in the same format that Pi's
    /// `get_messages` command returns. This is a fast path for session switching:
    /// the UI can render historical messages immediately while the Pi process
    /// warms up in the background.
    ///
    /// For sessions with branched history (forks), this traces back from the
    /// last message in the file (the tip of the current branch) to reconstruct
    /// the correct message chain.
    pub fn read_session_messages(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Vec<serde_json::Value>, HostDataError> {
        let path = self
            .resolve_session_path(workspace_id, session_id)?
            .ok_or_else(|| HostDataError::Io(format!("session {session_id} not found")))?;

        let file = std::fs::File::open(&path).map_err(|e| HostDataError::Io(e.to_string()))?;

        // Collect all JSONL entries: (id, parentId, message_value_if_type_message)
        let mut all_entries: Vec<(String, Option<String>, Option<serde_json::Value>)> = Vec::new();
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { continue };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(id) = entry
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            let parent_id = entry
                .get("parentId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let message_value =
                if entry.get("type").and_then(serde_json::Value::as_str) == Some("message") {
                    entry
                        .get("message")
                        .cloned()
                        .map(|message| message_with_entry_id(message, &id))
                } else {
                    None
                };
            all_entries.push((id, parent_id, message_value));
        }

        if all_entries.is_empty() {
            return Ok(vec![]);
        }

        // Build id -> index map for parentId traversal
        let id_to_idx: HashMap<&str, usize> = all_entries
            .iter()
            .enumerate()
            .map(|(i, (id, _, _))| (id.as_str(), i))
            .collect();

        // Find the last message entry — the tip of the current branch
        let Some(tip_idx) = all_entries
            .iter()
            .enumerate()
            .rev()
            .find(|(_, (_, _, msg))| msg.is_some())
            .map(|(i, _)| i)
        else {
            return Ok(vec![]);
        };

        // Walk back from the tip through parentId links, collecting message entries.
        // Non-message entries (model_change, thinking_level_change, etc.) are
        // traversed but not collected.
        let mut chain: Vec<serde_json::Value> = Vec::new();
        let mut current = tip_idx;
        let mut visited = std::collections::HashSet::new();
        loop {
            if !visited.insert(current) {
                break; // cycle guard
            }
            if let Some(msg) = &all_entries[current].2 {
                chain.push(msg.clone());
            }
            match all_entries[current].1.as_deref() {
                None => break,
                Some(pid) => match id_to_idx.get(pid) {
                    Some(&idx) => current = idx,
                    None => break,
                },
            }
        }
        chain.reverse();
        Ok(chain)
    }

    pub fn list_sessions(&self, workspace_id: &str) -> Result<Vec<SessionSummary>, HostDataError> {
        let workspace = self.workspace_root(workspace_id)?;
        let mut sessions = self.collect_sessions(Some(workspace.as_path()))?;
        for session in &mut sessions {
            session.workspace_id = workspace_id.to_owned();
            session.is_current_workspace = true;
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at_ms));
        Ok(sessions)
    }

    /// List saved sessions across *all* projects, not just the current
    /// workspace, so the sidebar can group them by project. Sessions that
    /// belong to `workspace_id` are tagged `is_current_workspace = true` and
    /// carry the live workspace id so the UI can open them in-window; all other
    /// sessions carry an empty workspace id and are opened by project path.
    pub fn list_all_sessions(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<SessionSummary>, HostDataError> {
        let current = self.workspace_root(workspace_id).ok();
        let mut sessions = self.collect_sessions(None)?;
        for session in &mut sessions {
            let project = PathBuf::from(&session.project_path);
            if current
                .as_ref()
                .is_some_and(|root| same_dir(root, &project))
            {
                session.workspace_id = workspace_id.to_owned();
                session.is_current_workspace = true;
            }
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at_ms));
        Ok(sessions)
    }

    /// Permanently delete the on-disk `.jsonl` files for the given session
    /// ids, searching across every project (not just the current workspace) —
    /// archived sessions in the sidebar can belong to any project. Best
    /// effort: each id lands in `deleted` or `errors`, a failure on one id
    /// never aborts the rest.
    pub fn delete_sessions(
        &self,
        session_ids: &[String],
    ) -> Result<DeleteSessionsResult, HostDataError> {
        let mut result = DeleteSessionsResult::default();
        if session_ids.is_empty() {
            return Ok(result);
        }
        let Some(session_root) = &self.session_root else {
            result.errors = session_ids.to_vec();
            return Ok(result);
        };
        if !session_root.is_dir() {
            result.errors = session_ids.to_vec();
            return Ok(result);
        }
        let requested: HashSet<&str> = session_ids.iter().map(String::as_str).collect();
        let mut deleted = HashSet::new();
        let mut failed = HashSet::new();
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
                let Some(session_id) = parse_session_id(&path)? else {
                    continue;
                };
                if !requested.contains(session_id.as_str()) {
                    continue;
                }
                match std::fs::remove_file(&path) {
                    Ok(()) => {
                        deleted.insert(session_id);
                    }
                    Err(_) => {
                        failed.insert(session_id);
                    }
                }
            }
        }
        for id in session_ids {
            if deleted.contains(id) && !failed.contains(id) {
                result.deleted.push(id.clone());
            } else {
                result.errors.push(id.clone());
            }
        }
        Ok(result)
    }

    /// Walk the session store and parse every `.jsonl` session file. When
    /// `workspace_filter` is `Some`, only sessions whose project directory
    /// matches are returned.
    fn collect_sessions(
        &self,
        workspace_filter: Option<&Path>,
    ) -> Result<Vec<SessionSummary>, HostDataError> {
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
            let Ok(files) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for file in files.filter_map(Result::ok) {
                let path = file.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(Some(summary)) = self.cached_session_summary(&path) else {
                    continue;
                };
                if let Some(filter) = workspace_filter {
                    if !same_dir(filter, Path::new(&summary.project_path)) {
                        continue;
                    }
                }
                sessions.push(summary);
            }
        }
        Ok(sessions)
    }

    fn cached_session_summary(&self, path: &Path) -> Result<Option<SessionSummary>, HostDataError> {
        let metadata =
            std::fs::metadata(path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let modified_at_ms = metadata_modified_at_ms(&metadata);
        let len = metadata.len();
        if let Some(cached) = self
            .session_summary_cache
            .read()
            .map_err(|_| HostDataError::Io("session summary cache poisoned".into()))?
            .get(path)
            .filter(|cached| cached.modified_at_ms == modified_at_ms && cached.len == len)
            .cloned()
        {
            return Ok(cached.summary);
        }

        let summary = parse_session_summary_with_metadata(path, modified_at_ms)?;
        self.session_summary_cache
            .write()
            .map_err(|_| HostDataError::Io("session summary cache poisoned".into()))?
            .insert(
                path.to_path_buf(),
                CachedSessionSummary {
                    modified_at_ms,
                    len,
                    summary: summary.clone(),
                },
            );
        Ok(summary)
    }

    pub fn search_sessions(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<Vec<SessionSearchResult>, HostDataError> {
        const MAX_RESULTS: usize = 30;
        let workspace = self.workspace_root(workspace_id)?;
        let workspace = workspace.as_path();
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
        let workspace = self.workspace_root(workspace_id)?;
        let workspace = workspace.as_path();
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
                metrics.cache_write += usage
                    .and_then(|usage| usage.get("cacheWrite"))
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
                metrics.tool_calls += tool_calls.len() as u64;
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
        let session_tokens =
            session.input_tokens + session.output_tokens + session.cache_read + session.cache_write;
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

    let mut session_rows: Vec<CostSessionRow> = sessions
        .into_iter()
        .map(|session| {
            let project_path = session
                .cwd
                .as_ref()
                .map(|cwd| cwd.to_string_lossy().into_owned())
                .unwrap_or_default();
            let project_name = session
                .cwd
                .as_ref()
                .and_then(|cwd| cwd.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| project_path.clone());
            CostSessionRow {
                id: session.id,
                title: session.title,
                model: session.model,
                time: session.timestamp,
                total_cost: session.total_cost,
                total_tokens: session.input_tokens
                    + session.output_tokens
                    + session.cache_read
                    + session.cache_write,
                input_tokens: session.input_tokens,
                output_tokens: session.output_tokens,
                cache_read: session.cache_read,
                cache_write: session.cache_write,
                tool_calls: session.tool_calls,
                tool_cost_by_name: session.tool_cost_by_name,
                user_messages: session.user_messages,
                project_path,
                project_name,
            }
        })
        .collect();
    session_rows.sort_by(|left, right| right.total_cost.total_cmp(&left.total_cost));
    dashboard.top_sessions = session_rows.iter().take(20).cloned().collect();
    dashboard.sessions = session_rows;
    dashboard
}

/// Compare two directories, preferring canonicalized equality but falling back
/// to a raw path comparison when a directory no longer exists on disk (so
/// sessions belonging to deleted projects still group correctly).
fn same_dir(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => left == right,
    }
}

/// Parse a session file into a summary. `project_path` is populated from the
/// session's `cwd` (its originating project); `workspace_id` /
/// `is_current_workspace` are left empty here and filled in by the caller,
/// which knows the workspace the sidebar is showing.
fn parse_session_id(path: &Path) -> Result<Option<String>, HostDataError> {
    let file = std::fs::File::open(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(serde_json::Value::as_str) == Some("session") {
            return Ok(entry
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned));
        }
    }
    Ok(None)
}

fn metadata_modified_at_ms(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis())
}

fn parse_session_summary(path: &Path) -> Result<Option<SessionSummary>, HostDataError> {
    let metadata = std::fs::metadata(path).map_err(|error| HostDataError::Io(error.to_string()))?;
    parse_session_summary_with_metadata(path, metadata_modified_at_ms(&metadata))
}

fn parse_session_summary_with_metadata(
    path: &Path,
    modified_at_ms: u128,
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
    let Some(cwd) = cwd else {
        return Ok(None);
    };
    let project_path = cwd.canonicalize().unwrap_or(cwd);
    let project_name = project_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| project_path.to_string_lossy().into_owned());
    Ok(Some(SessionSummary {
        id,
        timestamp,
        name,
        first_message,
        workspace_id: String::new(),
        project_path: project_path.to_string_lossy().into_owned(),
        project_name,
        is_current_workspace: false,
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
    use serde_json::json;
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

    #[test]
    fn read_session_messages_preserves_user_entry_ids() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-messages-{nonce}"));
        let workspace = temp.join("workspace");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("session-a.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n\
                 {{\"type\":\"message\",\"id\":\"user-1\",\"parentId\":null,\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n\
                 {{\"type\":\"message\",\"id\":\"assistant-1\",\"parentId\":\"user-1\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"hi\"}}]}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let messages = data
            .read_session_messages("workspace-a", "session-a")
            .unwrap();

        assert_eq!(
            messages,
            vec![
                json!({ "role": "user", "content": "hello", "entryId": "user-1" }),
                json!({ "role": "assistant", "content": [{ "type": "text", "text": "hi" }] }),
            ]
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
        assert!(listed[0].is_current_workspace);
        assert_eq!(listed[0].workspace_id, "workspace-a");
        assert_eq!(
            listed[0].first_message.as_deref(),
            Some("hello from session")
        );

        // list_all_sessions returns both projects, tagging only the current
        // workspace's session as current.
        let all = data.list_all_sessions("workspace-a").unwrap();
        assert_eq!(all.len(), 2);
        let current = all.iter().find(|s| s.id == "session-a").unwrap();
        assert!(current.is_current_workspace);
        assert_eq!(current.workspace_id, "workspace-a");
        let foreign = all.iter().find(|s| s.id == "session-b").unwrap();
        assert!(!foreign.is_current_workspace);
        assert!(foreign.workspace_id.is_empty());
        assert!(foreign.project_path.ends_with("other"));
        assert_eq!(foreign.project_name, "other");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn list_all_sessions_skips_unreadable_session_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-sessions-unreadable-{nonce}"));
        let workspace = temp.join("workspace");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("included.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello from session\"}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let broken = sessions.join("broken.jsonl");
        fs::write(&broken, "").unwrap();
        fs::remove_file(&broken).unwrap();
        fs::create_dir(&broken).unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let all = data.list_all_sessions("workspace-a").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "session-a");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn deletes_sessions_by_id_across_projects_and_reports_missing_ids_as_errors() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-delete-{nonce}"));
        let workspace = temp.join("workspace");
        let other = temp.join("other");
        let sessions_a = temp.join("sessions/project-a");
        let sessions_b = temp.join("sessions/project-b");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions_a).unwrap();
        fs::create_dir_all(&sessions_b).unwrap();
        let file_a = sessions_a.join("a.jsonl");
        let file_b = sessions_b.join("b.jsonl");
        fs::write(
            &file_a,
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            &file_b,
            format!(
                "{{\"type\":\"session\",\"id\":\"session-b\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"other project\"}}}}\n",
                serde_json::to_string(&other.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let result = data
            .delete_sessions(&[
                "session-a".to_owned(),
                "session-b".to_owned(),
                "missing".to_owned(),
            ])
            .unwrap();
        assert_eq!(result.deleted, vec!["session-a", "session-b"]);
        assert_eq!(result.errors, vec!["missing"]);
        assert!(!file_a.exists());
        assert!(!file_b.exists());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn deletes_session_files_that_are_not_visible_session_summaries() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-delete-hidden-{nonce}"));
        let workspace = temp.join("workspace");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("empty.jsonl");
        fs::write(
            &file,
            format!(
                "{{\"type\":\"session\",\"id\":\"session-empty\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"session_info\",\"name\":\"New thread\"}}\n",
                serde_json::to_string(&workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        assert!(data.list_all_sessions("workspace-a").unwrap().is_empty());
        let result = data.delete_sessions(&["session-empty".to_owned()]).unwrap();

        assert_eq!(result.deleted, vec!["session-empty"]);
        assert!(result.errors.is_empty());
        assert!(!file.exists());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn deletes_every_session_file_with_a_matching_id() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-delete-duplicates-{nonce}"));
        let workspace = temp.join("workspace");
        let sessions_a = temp.join("sessions/project-a");
        let sessions_b = temp.join("sessions/project-b");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions_a).unwrap();
        fs::create_dir_all(&sessions_b).unwrap();
        let file_a = sessions_a.join("a.jsonl");
        let file_b = sessions_b.join("b.jsonl");
        let contents = format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap()
        );
        fs::write(&file_a, &contents).unwrap();
        fs::write(&file_b, &contents).unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let result = data.delete_sessions(&["session-a".to_owned()]).unwrap();

        assert_eq!(result.deleted, vec!["session-a"]);
        assert!(result.errors.is_empty());
        assert!(!file_a.exists());
        assert!(!file_b.exists());
        assert!(data.list_all_sessions("workspace-a").unwrap().is_empty());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn resolves_the_file_path_for_a_saved_session_in_the_workspace() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-resolve-{nonce}"));
        let workspace = temp.join("workspace");
        let other = temp.join("other");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        let included = sessions.join("included.jsonl");
        fs::write(
            &included,
            format!(
                "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n",
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

        assert_eq!(
            data.resolve_session_path("workspace-a", "session-a")
                .unwrap(),
            Some(included)
        );
        // A session owned by another workspace is not resolvable here.
        assert_eq!(
            data.resolve_session_path("workspace-a", "session-b")
                .unwrap(),
            None
        );
        // Unknown session id resolves to nothing.
        assert_eq!(
            data.resolve_session_path("workspace-a", "missing").unwrap(),
            None
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
