use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, RwLock};

use crate::markitdown_preview::{is_convertible_suffix, INPUT_BYTE_CAP};

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
    /// Whether the workspace root is inside a git work tree.
    pub is_git: bool,
    /// Top-level directory name of the git repository (e.g. "picot").
    pub repository: String,
    /// Current branch name (empty string in detached HEAD).
    pub branch: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMentionCandidate {
    pub value: String,
    pub label: String,
    pub description: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMentionSearchResult {
    pub items: Vec<FileMentionCandidate>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub mime_type: String,
    pub is_binary: bool,
    pub truncated: bool,
    pub editable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawFileContent {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub size: u64,
}

pub struct ConvertibleFile {
    pub path: String,
    pub bytes: Vec<u8>,
    pub suffix: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub is_git_repository: bool,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatResult {
    pub is_git_repository: bool,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub supported: bool,
    pub status: Option<String>,
    pub patch: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WriteFileResult {
    Saved { size: u64, mtime_ms: f64 },
    Conflict,
    Invalid,
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
    /// Absolute path to the persisted JSONL session file.
    pub file_path: String,
    pub file_name: String,
    /// Filesystem mtime for cache invalidation/debugging only. UI recency uses
    /// `activity_at_ms` so a read-only resume/touch does not reorder projects.
    pub modified_at_ms: u128,
    /// Last user-message timestamp when available; falls back to the session
    /// header timestamp, then filesystem mtime for legacy/incomplete files.
    pub activity_at_ms: u128,
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
    NotFile,
    InvalidMentionQuery,
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

/// Parse a number from `git diff --shortstat` output for a given keyword.
/// e.g. `parse_shortstat_num("3 files changed, 10 insertions(+)", "insertion")` → 10
fn parse_shortstat_num(line: &str, keyword: &str) -> u32 {
    line.split(',')
        .find_map(|part| {
            let part = part.trim();
            if part.contains(keyword) {
                part.split_whitespace().next().and_then(|n| n.parse().ok())
            } else {
                None
            }
        })
        .unwrap_or(0)
}

fn classify_git_status(x: char, y: char) -> (&'static str, &'static str) {
    if matches!((x, y), ('D', 'D') | ('A', 'A')) || x == 'U' || y == 'U' {
        ("conflict", "C")
    } else if x == '?' && y == '?' {
        ("untracked", "U")
    } else if x == 'D' || y == 'D' {
        ("deleted", "D")
    } else if x == 'R' || y == 'R' {
        ("renamed", "R")
    } else if x == 'A' || y == 'A' {
        ("added", "A")
    } else {
        ("modified", "M")
    }
}

/// Git is optional. Spawn failures (missing binary, stripped GUI PATH) must
/// not become host I/O errors — Picot should keep running without git.
fn git_output(mut command: Command) -> Option<std::process::Output> {
    command.output().ok()
}

fn git_command_at(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

fn git_at(root: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut command = git_command_at(root);
    command.args(args);
    git_output(command)
}

fn empty_git_status() -> GitStatusResult {
    GitStatusResult {
        is_git_repository: false,
        files: vec![],
    }
}

fn empty_git_stat() -> GitStatResult {
    GitStatResult {
        is_git_repository: false,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
    }
}

fn empty_workspace_git(path: String) -> WorkspaceInfo {
    WorkspaceInfo {
        path,
        git_branch: None,
        is_git: false,
        repository: String::new(),
        branch: String::new(),
    }
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

    pub fn search_file_mentions(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<FileMentionSearchResult, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        if !query.starts_with('@') || query.contains('\0') {
            return Err(HostDataError::InvalidMentionQuery);
        }
        let raw = query.strip_prefix('@').unwrap_or_default();
        let (is_quoted, body) = if let Some(rest) = raw.strip_prefix('"') {
            (true, rest.strip_suffix('"').unwrap_or(rest))
        } else {
            (false, raw)
        };
        let normalized = body.replace('\\', "/");
        if normalized.starts_with('/') || normalized.split('/').any(|part| part == "..") {
            return Err(HostDataError::InvalidMentionQuery);
        }
        let (display_base, fuzzy) = match normalized.rsplit_once('/') {
            Some((base, fuzzy)) => (format!("{base}/"), fuzzy.to_owned()),
            None => (String::new(), normalized.clone()),
        };
        if normalized
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .any(is_ignored_mention_dir)
        {
            return Ok(FileMentionSearchResult {
                items: Vec::new(),
                truncated: false,
            });
        }
        let base_dir = match safe_join(&root, &display_base) {
            Ok(path) => path,
            Err(HostDataError::Io(_)) | Err(HostDataError::NotDirectory) => {
                return Ok(FileMentionSearchResult {
                    items: Vec::new(),
                    truncated: false,
                });
            }
            Err(error) => return Err(error),
        };
        let mut walk = FileMentionWalk::new(root.as_path(), fuzzy.to_lowercase(), is_quoted);
        walk.collect(&base_dir, &display_base)?;
        walk.collected.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.description.cmp(&right.1.description))
        });
        Ok(FileMentionSearchResult {
            items: walk
                .collected
                .into_iter()
                .take(20)
                .map(|(_, item)| item)
                .collect(),
            truncated: walk.truncated,
        })
    }

    pub fn read_file_content(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<FileContent, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let path = safe_join(&root, relative_path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        if !metadata.is_file() {
            return Err(HostDataError::NotFile);
        }

        let mut file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut prefix = [0_u8; BINARY_PREFIX_BYTES];
        let prefix_len = file
            .read(&mut prefix)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        let classification = classify_preview_file(&path, &prefix[..prefix_len]);
        let mtime_ms = file_mtime_ms(&metadata)?;

        if matches!(
            classification.kind,
            PreviewFileKind::Image | PreviewFileKind::Pdf
        ) {
            return Ok(FileContent {
                path: relative_path.to_owned(),
                content: String::new(),
                size: metadata.len(),
                mtime_ms,
                mime_type: classification.mime_type.to_owned(),
                is_binary: false,
                truncated: false,
                editable: false,
            });
        }

        if classification.kind != PreviewFileKind::Text {
            return Ok(FileContent {
                path: relative_path.to_owned(),
                content: String::new(),
                size: metadata.len(),
                mtime_ms,
                mime_type: classification.mime_type.to_owned(),
                is_binary: true,
                truncated: false,
                editable: false,
            });
        }

        let read_len = metadata.len().min(TEXT_READ_LIMIT as u64) as usize;
        let mut file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut buf = vec![0_u8; read_len];
        let bytes_read = file
            .read(&mut buf)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        buf.truncate(bytes_read);
        let is_binary = is_binary_by_prefix(&buf);
        Ok(FileContent {
            path: relative_path.to_owned(),
            content: String::from_utf8_lossy(&buf).into_owned(),
            size: metadata.len(),
            mtime_ms,
            mime_type: classification.mime_type.to_owned(),
            is_binary,
            truncated: metadata.len() > TEXT_READ_LIMIT as u64,
            editable: classification.editable
                && !is_binary
                && metadata.len() <= EDIT_SIZE_LIMIT as u64,
        })
    }

    pub fn read_convertible_file(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<Option<ConvertibleFile>, HostDataError> {
        let suffix = preview_extension(Path::new(relative_path));
        if !is_convertible_suffix(&suffix) {
            return Ok(None);
        }
        let root = self.workspace_root(workspace_id)?;
        let path = safe_join(&root, relative_path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        if !metadata.is_file() {
            return Err(HostDataError::NotFile);
        }
        if metadata.len() > INPUT_BYTE_CAP {
            return Ok(Some(ConvertibleFile {
                path: relative_path.to_owned(),
                bytes: Vec::new(),
                suffix,
                size: metadata.len(),
                mtime_ms: file_mtime_ms(&metadata)?,
                mime_type: "application/octet-stream".into(),
            }));
        }
        let file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(INPUT_BYTE_CAP + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        Ok(Some(ConvertibleFile {
            path: relative_path.to_owned(),
            bytes,
            suffix,
            size: metadata.len(),
            mtime_ms: file_mtime_ms(&metadata)?,
            mime_type: "application/octet-stream".into(),
        }))
    }

    pub fn raw_file_content(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<RawFileContent, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let path = safe_join(&root, relative_path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        if !metadata.is_file() {
            return Err(HostDataError::NotFile);
        }
        let mut file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut prefix = [0_u8; BINARY_PREFIX_BYTES];
        let prefix_len = file
            .read(&mut prefix)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        let classification = classify_preview_file(&path, &prefix[..prefix_len]);
        if !matches!(
            classification.kind,
            PreviewFileKind::Image | PreviewFileKind::Pdf
        ) {
            return Err(HostDataError::NotFile);
        }
        let bytes = std::fs::read(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        Ok(RawFileContent {
            bytes,
            mime_type: classification.mime_type.to_owned(),
            size: metadata.len(),
        })
    }

    pub fn git_status(&self, workspace_id: &str) -> Result<GitStatusResult, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let Some(output) = git_at(
            &root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        ) else {
            return Ok(empty_git_status());
        };
        if !output.status.success() {
            return Ok(empty_git_status());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let records: Vec<&str> = text.split('\0').collect();
        let mut files = Vec::new();
        let mut index = 0;
        while index < records.len() {
            let record = records[index];
            index += 1;
            if record.len() < 4 {
                continue;
            }
            let bytes = record.as_bytes();
            let x = bytes[0] as char;
            let y = bytes[1] as char;
            let path = record[3..].to_owned();
            let original_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
                let original = records
                    .get(index)
                    .filter(|value| !value.is_empty())
                    .map(|value| (*value).to_owned());
                if original.is_some() {
                    index += 1;
                }
                original
            } else {
                None
            };
            let (status, code) = classify_git_status(x, y);
            files.push(GitFileStatus {
                path,
                original_path,
                status: status.into(),
                code: code.into(),
            });
        }
        Ok(GitStatusResult {
            is_git_repository: true,
            files,
        })
    }

    pub fn git_file_diff(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<GitDiffResult, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let _ = safe_join(&root, relative_path)?;
        let status = self
            .git_status(workspace_id)?
            .files
            .into_iter()
            .find(|file| file.path == relative_path);
        let Some(file) = status else {
            return Ok(GitDiffResult {
                supported: false,
                status: None,
                patch: None,
            });
        };
        let mut command = git_command_at(&root);
        if file.status == "untracked" {
            let absolute = safe_join(&root, relative_path)?;
            command
                .args([
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-index",
                    "/dev/null",
                ])
                .arg(absolute);
        } else {
            command.args([
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                "HEAD",
                "--",
            ]);
            if let Some(original) = &file.original_path {
                command.arg(original);
            }
            command.arg(relative_path);
        }
        let Some(output) = git_output(command) else {
            return Ok(GitDiffResult {
                supported: false,
                status: None,
                patch: None,
            });
        };
        // git diff --no-index reports differences with exit status 1.
        if !output.status.success() && output.status.code() != Some(1) {
            return Ok(GitDiffResult {
                supported: false,
                status: None,
                patch: None,
            });
        }
        let patch = String::from_utf8_lossy(&output.stdout).into_owned();
        let supported = patch.contains("\n@@ ");
        Ok(GitDiffResult {
            supported,
            status: Some(file.status),
            patch: supported.then_some(patch),
        })
    }

    pub fn git_stat(&self, workspace_id: &str) -> Result<GitStatResult, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        // Check if this is a git repo first
        let Some(check) = git_at(&root, &["rev-parse", "--is-inside-work-tree"]) else {
            return Ok(empty_git_stat());
        };
        if !check.status.success() {
            return Ok(empty_git_stat());
        }
        // git diff --shortstat HEAD gives: " N files changed, X insertions(+), Y deletions(-)"
        // If HEAD doesn't exist (initial commit), fall back to diffing against empty tree
        let Some(output) = git_at(&root, &["diff", "--shortstat", "HEAD"]) else {
            return Ok(empty_git_stat());
        };
        let line = String::from_utf8_lossy(&output.stdout);
        let line = line.trim();
        // Parse: "3 files changed, 10 insertions(+), 2 deletions(-)"
        let files_changed = parse_shortstat_num(line, "file");
        let insertions = parse_shortstat_num(line, "insertion");
        let deletions = parse_shortstat_num(line, "deletion");
        Ok(GitStatResult {
            is_git_repository: true,
            files_changed,
            insertions,
            deletions,
        })
    }

    pub fn write_file_content(
        &self,
        workspace_id: &str,
        relative_path: &str,
        content: &str,
        expected_mtime_ms: f64,
        force: bool,
    ) -> Result<WriteFileResult, HostDataError> {
        if content.len() > EDIT_SIZE_LIMIT {
            return Ok(WriteFileResult::Invalid);
        }
        let root = self.workspace_root(workspace_id)?;
        let path = safe_join(&root, relative_path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        if !metadata.is_file() || metadata.len() > EDIT_SIZE_LIMIT as u64 {
            return Ok(WriteFileResult::Invalid);
        }
        let mut file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut prefix = [0_u8; BINARY_PREFIX_BYTES];
        let prefix_len = file
            .read(&mut prefix)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        if classify_preview_file(&path, &prefix[..prefix_len]).kind != PreviewFileKind::Text {
            return Ok(WriteFileResult::Invalid);
        }
        let current_mtime_ms = file_mtime_ms(&metadata)?;
        if !force && (current_mtime_ms - expected_mtime_ms).abs() > 1.0 {
            return Ok(WriteFileResult::Conflict);
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        file.write_all(content.as_bytes())
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        file.sync_all()
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        let metadata = file
            .metadata()
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        Ok(WriteFileResult::Saved {
            size: metadata.len(),
            mtime_ms: file_mtime_ms(&metadata)?,
        })
    }

    /// Return the registered filesystem root (working directory) for a
    /// workspace, so a runtime can be lazily resumed with the correct cwd.
    pub fn workspace_root_path(&self, workspace_id: &str) -> Result<PathBuf, HostDataError> {
        self.workspace_root(workspace_id)
    }

    /// Return the workspace path and its current git metadata (repository
    /// name + branch) for the sidebar hover quick-info card. The JSON shape
    /// (`{ isGit, repository, branch, path, gitBranch }`) matches the
    /// `/api/workspace-info` contract consumed by `WorkspaceQuickInfo`.
    pub fn workspace_info(&self, workspace_id: &str) -> Result<WorkspaceInfo, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        Self::workspace_info_from_root(&root)
    }

    /// Variant that accepts an on-disk workspace path directly (used by
    /// the sidebar which only knows the projectPath, not the internal
    /// workspace ID). The path is canonicalized before running git.
    pub fn workspace_info_by_path(
        &self,
        workspace_path: &str,
    ) -> Result<WorkspaceInfo, HostDataError> {
        let root =
            std::fs::canonicalize(workspace_path).map_err(|e| HostDataError::Io(e.to_string()))?;
        Self::workspace_info_from_root(&root)
    }

    fn workspace_info_from_root(root: &std::path::Path) -> Result<WorkspaceInfo, HostDataError> {
        let path = root.to_string_lossy().into_owned();
        let Some(check) = git_at(root, &["rev-parse", "--is-inside-work-tree"]) else {
            return Ok(empty_workspace_git(path));
        };
        if !check.status.success() {
            return Ok(empty_workspace_git(path));
        }
        // Repository name = top-level directory name of the worktree root.
        let Some(toplevel) = git_at(root, &["rev-parse", "--show-toplevel"]) else {
            return Ok(empty_workspace_git(path));
        };
        let repo_path = String::from_utf8_lossy(&toplevel.stdout).trim().to_string();
        let repository = std::path::Path::new(&repo_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // Branch name (None in detached HEAD for git_branch, empty string for branch).
        let branch_out = git_at(root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty() && s != "HEAD");
        let branch = branch_out.clone().unwrap_or_default();
        Ok(WorkspaceInfo {
            path,
            git_branch: branch_out,
            is_git: true,
            repository,
            branch,
        })
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
                // The sidebar normally populated this cache immediately before
                // a session is selected. Reusing it avoids reparsing every
                // JSONL file in every project on each session switch.
                let Some(summary) = self.cached_session_summary(&path)? else {
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
        sessions.sort_by_key(|session| std::cmp::Reverse(session.activity_at_ms));
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
        let current = self
            .workspace_root(workspace_id)
            .ok()
            .map(|root| (workspace_id, root));
        self.list_all_sessions_with_current(current)
    }

    /// List saved sessions for the targetless `/app` launcher. No workspace is
    /// marked current, so selecting any result follows the existing
    /// cross-project resolution flow before navigating to its canonical route.
    pub fn list_launcher_sessions(&self) -> Result<Vec<SessionSummary>, HostDataError> {
        self.list_all_sessions_with_current(None)
    }

    fn list_all_sessions_with_current(
        &self,
        current: Option<(&str, PathBuf)>,
    ) -> Result<Vec<SessionSummary>, HostDataError> {
        let mut sessions = self.collect_sessions(None)?;
        if let Some((workspace_id, root)) = current {
            for session in &mut sessions {
                if same_dir(&root, Path::new(&session.project_path)) {
                    session.workspace_id = workspace_id.to_owned();
                    session.is_current_workspace = true;
                }
            }
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.activity_at_ms));
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
                let is_regular_file = file.file_type().is_ok_and(|file_type| file_type.is_file());
                if !is_regular_file
                    || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
                {
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
        // Validate the workspace id (keeps the RPC contract), but the dashboard
        // aggregates usage across ALL projects under the session root — the UI
        // is designed to rank projects globally, not scope to one workspace.
        let _ = self.workspace_root(workspace_id)?;
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
                if let Some(metrics) = parse_session_metrics(&path, None)? {
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
    workspace: Option<&Path>,
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
    if let Some(workspace) = workspace {
        let Some(cwd) = metrics.cwd.as_ref() else {
            return Ok(None);
        };
        if !same_dir(cwd, workspace) {
            return Ok(None);
        }
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

fn timestamp_value_ms(value: Option<&serde_json::Value>) -> Option<u128> {
    match value? {
        serde_json::Value::Number(number) => number.as_u64().map(u128::from),
        serde_json::Value::String(text) => iso_timestamp_ms(text),
        _ => None,
    }
}

fn iso_timestamp_ms(text: &str) -> Option<u128> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (date, time) = trimmed.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let time = time.strip_suffix('Z').unwrap_or(time);
    if time.contains('+') || time.rmatch_indices('-').any(|(index, _)| index > 0) {
        return None;
    }
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second_text = time_parts.next()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 {
        return None;
    }
    let (second_whole, fraction) = second_text
        .split_once('.')
        .map_or((second_text, ""), |(whole, fraction)| (whole, fraction));
    let second = second_whole.parse::<u32>().ok()?;
    if second > 59 {
        return None;
    }
    let millis = fraction
        .chars()
        .take(3)
        .try_fold((0_u32, 0_u32), |(value, digits), ch| {
            ch.to_digit(10)
                .map(|digit| (value * 10 + digit, digits + 1))
        })
        .map(|(value, digits)| value * 10_u32.pow(3 - digits))
        .unwrap_or(0);

    let days = days_from_civil(year, month, day)?;
    Some(
        days as u128 * 86_400_000
            + hour as u128 * 3_600_000
            + minute as u128 * 60_000
            + second as u128 * 1_000
            + millis as u128,
    )
}

// Howard Hinnant's days-from-civil algorithm. Returns days since 1970-01-01.
fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era as i64 * 146_097 + doe as i64 - 719_468;
    (days >= 0).then_some(days)
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
    let mut last_user_message_at_ms = None;
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
                last_user_message_at_ms = timestamp_value_ms(
                    entry
                        .pointer("/message/timestamp")
                        .or_else(|| entry.get("timestamp")),
                )
                .or(last_user_message_at_ms);
                if first_message.is_none() {
                    first_message = message_text(entry.pointer("/message/content"))
                        .map(|text| text.chars().take(120).collect());
                }
            }
            _ => {}
        }
        // The session display name (`session_info`) is appended at the end of the
        // file when the agent settles. Do not break early until we've read it,
        // otherwise every session over 50 lines shows the first message instead
        // of its name. Only stop once both `first_message` and `name` are known.
        if line_count > 50 && first_message.is_some() && name.is_some() {
            break;
        }
    }
    let Some(id) = id else { return Ok(None) };
    if user_message_count == 0 && line_count <= 4 && name.as_deref() != Some("Agent Inbox") {
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
    let activity_at_ms = last_user_message_at_ms
        .or_else(|| iso_timestamp_ms(&timestamp))
        .unwrap_or(modified_at_ms);
    Ok(Some(SessionSummary {
        id,
        timestamp,
        name,
        first_message,
        workspace_id: String::new(),
        project_path: project_path.to_string_lossy().into_owned(),
        project_name,
        is_current_workspace: false,
        file_path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        modified_at_ms,
        activity_at_ms,
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

const TEXT_READ_LIMIT: usize = 2 * 1024 * 1024;
const EDIT_SIZE_LIMIT: usize = 1024 * 1024;
const BINARY_PREFIX_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewFileKind {
    Text,
    Image,
    Pdf,
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PreviewFileClassification {
    mime_type: &'static str,
    kind: PreviewFileKind,
    editable: bool,
}

const IGNORED_MENTION_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    ".cache",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
];

fn is_ignored_mention_dir(name: &str) -> bool {
    IGNORED_MENTION_DIRS.contains(&name)
}

struct FileMentionWalk<'a> {
    root: &'a Path,
    fuzzy: String,
    is_quoted: bool,
    visited: usize,
    collected: Vec<(u16, FileMentionCandidate)>,
    truncated: bool,
}

impl<'a> FileMentionWalk<'a> {
    fn new(root: &'a Path, fuzzy: String, is_quoted: bool) -> Self {
        Self {
            root,
            fuzzy,
            is_quoted,
            visited: 0,
            collected: Vec::new(),
            truncated: false,
        }
    }

    fn collect(&mut self, dir: &Path, display_base: &str) -> Result<(), HostDataError> {
        if self.visited >= 10_000 || self.collected.len() >= 200 {
            self.truncated = true;
            return Ok(());
        }
        let entries =
            std::fs::read_dir(dir).map_err(|error| HostDataError::Io(error.to_string()))?;
        for entry in entries.filter_map(Result::ok) {
            if self.visited >= 10_000 || self.collected.len() >= 200 {
                self.truncated = true;
                return Ok(());
            }
            self.visited += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let is_directory = file_type.is_dir();
            if !is_directory && !file_type.is_file() {
                continue;
            }
            if is_directory && is_ignored_mention_dir(&name) {
                continue;
            }
            let display_path = format!("{display_base}{name}");
            let score = score_mention(&display_path, &name, &self.fuzzy, is_directory);
            if score > 0 {
                self.collected.push((
                    score,
                    build_file_mention_candidate(
                        &display_path,
                        is_directory,
                        is_quoted_display(self.is_quoted, &display_path),
                    ),
                ));
            }
            if is_directory {
                let path = entry.path();
                if path.starts_with(self.root) {
                    self.collect(&path, &format!("{display_path}/"))?;
                }
            }
        }
        Ok(())
    }
}

fn score_mention(display_path: &str, name: &str, fuzzy: &str, is_directory: bool) -> u16 {
    let base = if fuzzy.is_empty() {
        if is_directory {
            11
        } else {
            1
        }
    } else {
        let name = name.to_lowercase();
        if name == fuzzy {
            100
        } else if name.starts_with(fuzzy) {
            80
        } else if name.contains(fuzzy) {
            50
        } else if display_path.to_lowercase().contains(fuzzy) {
            30
        } else {
            0
        }
    };
    if base > 0 && is_directory {
        base + 10
    } else {
        base
    }
}

fn is_quoted_display(was_quoted: bool, display_path: &str) -> bool {
    was_quoted || display_path.contains(' ')
}

fn build_file_mention_candidate(
    display_path: &str,
    is_directory: bool,
    needs_quotes: bool,
) -> FileMentionCandidate {
    let value_path = if is_directory {
        format!("{display_path}/")
    } else {
        display_path.to_owned()
    };
    let value = if needs_quotes {
        format!("@\"{value_path}\"")
    } else {
        format!("@{value_path}")
    };
    let label = Path::new(display_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(display_path);
    FileMentionCandidate {
        value,
        label: format!("{label}{}", if is_directory { "/" } else { "" }),
        description: display_path.to_owned(),
        is_directory,
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

fn file_mtime_ms(metadata: &std::fs::Metadata) -> Result<f64, HostDataError> {
    let modified = metadata
        .modified()
        .map_err(|error| HostDataError::Io(error.to_string()))?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| HostDataError::Io(error.to_string()))?;
    Ok(duration.as_secs_f64() * 1000.0)
}

fn preview_extension(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| {
            name.rsplit_once('.')
                .map(|(_, ext)| ext.to_ascii_lowercase())
        })
        .unwrap_or_default()
}

fn is_binary_by_prefix(prefix: &[u8]) -> bool {
    prefix
        .iter()
        .take(BINARY_PREFIX_BYTES)
        .any(|byte| *byte == 0)
}

fn classify_preview_file(path: &Path, prefix: &[u8]) -> PreviewFileClassification {
    let ext = preview_extension(path);
    if ext == "pdf" || prefix.starts_with(b"%PDF") {
        return PreviewFileClassification {
            mime_type: "application/pdf",
            kind: PreviewFileKind::Pdf,
            editable: false,
        };
    }
    if let Some(mime_type) = image_mime_type(&ext) {
        return PreviewFileClassification {
            mime_type,
            kind: PreviewFileKind::Image,
            editable: false,
        };
    }
    if ext == "mbox" || is_convertible_suffix(&ext) {
        return PreviewFileClassification {
            mime_type: "application/octet-stream",
            kind: PreviewFileKind::Binary,
            editable: false,
        };
    }
    if is_binary_by_prefix(prefix) {
        return PreviewFileClassification {
            mime_type: "application/octet-stream",
            kind: PreviewFileKind::Binary,
            editable: false,
        };
    }
    PreviewFileClassification {
        mime_type: text_mime_type(&ext),
        kind: PreviewFileKind::Text,
        editable: true,
    }
}

fn image_mime_type(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn text_mime_type(ext: &str) -> &'static str {
    match ext {
        "js" | "jsx" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" | "mts" | "cts" => "text/typescript",
        "json" | "jsonc" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "toml" => "application/toml",
        "xml" => "text/xml",
        "html" | "htm" => "text/html",
        "css" | "scss" | "sass" | "less" => "text/css",
        "md" | "markdown" | "mdown" | "mkd" => "text/markdown",
        "py" | "pyw" | "pyi" => "text/x-python",
        "r" => "text/x-r-source",
        "rb" => "text/x-ruby",
        "go" => "text/x-go",
        "rs" => "text/x-rust",
        "c" | "h" => "text/x-c",
        "cpp" | "hpp" | "cc" => "text/x-c++",
        "sh" | "bash" | "zsh" => "application/x-sh",
        "sql" => "application/sql",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "log" | "env" | "conf" | "ini" | "cfg" => "text/plain",
        "diff" | "patch" => "text/x-diff",
        _ => "text/plain",
    }
}

#[cfg(test)]
mod tests {
    use super::{git_output, FileKind, HostDataError, HostDataPlane};
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::io::Write;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn isolated_workspace(label: &str) -> (std::path::PathBuf, HostDataPlane, std::path::PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-{label}-{nonce}"));
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let data =
            HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace.clone())])).unwrap();
        (temp, data, workspace)
    }

    #[test]
    fn missing_git_binary_is_treated_as_unavailable() {
        let mut command = Command::new("picot-missing-git-binary-for-tests");
        command.arg("--version");
        assert!(git_output(command).is_none());
    }

    #[test]
    fn workspace_info_without_git_metadata_still_returns_the_path() {
        let (temp, data, workspace) = isolated_workspace("git-optional-info");
        let info = data.workspace_info("workspace-a").unwrap();
        assert_eq!(
            info.path,
            workspace.canonicalize().unwrap().to_string_lossy()
        );
        assert!(!info.is_git);
        assert!(info.git_branch.is_none());
        assert!(info.repository.is_empty());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn git_status_and_stat_without_a_repository_are_empty_not_errors() {
        let (temp, data, _) = isolated_workspace("git-optional-status");
        let status = data.git_status("workspace-a").unwrap();
        assert!(!status.is_git_repository);
        assert!(status.files.is_empty());
        let stat = data.git_stat("workspace-a").unwrap();
        assert!(!stat.is_git_repository);
        assert_eq!(stat.files_changed, 0);
        fs::remove_dir_all(temp).unwrap();
    }

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

        // The canonical /app launcher is targetless: it returns the same
        // catalog without inventing a current workspace.
        let launcher = data.list_launcher_sessions().unwrap();
        assert_eq!(launcher.len(), 2);
        assert!(launcher
            .iter()
            .all(|session| !session.is_current_workspace && session.workspace_id.is_empty()));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn list_all_sessions_orders_by_user_activity_not_file_mtime() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-session-activity-{nonce}"));
        let older_workspace = temp.join("older-workspace");
        let newer_workspace = temp.join("newer-workspace");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&older_workspace).unwrap();
        fs::create_dir_all(&newer_workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();

        let older_file = sessions.join("older.jsonl");
        fs::write(
            &older_file,
            format!(
                "{{\"type\":\"session\",\"id\":\"older\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":{}}}\n\
                 {{\"type\":\"message\",\"timestamp\":\"2026-01-01T00:00:01.000Z\",\"message\":{{\"role\":\"user\",\"timestamp\":1767225601000,\"content\":\"older activity\"}}}}\n",
                serde_json::to_string(&older_workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("newer.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"newer\",\"timestamp\":\"2026-01-02T00:00:00.000Z\",\"cwd\":{}}}\n\
                 {{\"type\":\"message\",\"timestamp\":\"2026-01-02T00:00:01.000Z\",\"message\":{{\"role\":\"user\",\"timestamp\":1767312001000,\"content\":\"newer activity\"}}}}\n",
                serde_json::to_string(&newer_workspace.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        // Simulate a read-only resume/touch writing metadata to the older
        // session after the newer conversation activity already happened. This
        // must not pull the older project to the top of the sidebar.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::OpenOptions::new()
            .append(true)
            .open(&older_file)
            .unwrap()
            .write_all(b"{\"type\":\"session_info\",\"name\":\"Touched title\"}\n")
            .unwrap();

        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), older_workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let all = data.list_all_sessions("workspace-a").unwrap();
        assert_eq!(
            all.iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            vec!["newer", "older"]
        );
        assert!(all[1].modified_at_ms > all[0].modified_at_ms);
        assert!(all[0].activity_at_ms > all[1].activity_at_ms);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reads_session_name_appended_after_many_messages() {
        // Regression: the summary parser used to stop scanning after 50 lines,
        // so a `session_info` name appended at the end of a long session was
        // never read and the list fell back to the first message.
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-session-name-{nonce}"));
        let workspace = temp.join("workspace");
        let sessions = temp.join("sessions/project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        let mut file = format!(
            "{{\"type\":\"session\",\"id\":\"session-a\",\"timestamp\":\"2026-01-01\",\"cwd\":{}}}\n",
            serde_json::to_string(&workspace.to_string_lossy()).unwrap(),
        );
        file.push_str(
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"first turn\"}}\n",
        );
        // Push well past the 50-line early-break threshold.
        for _ in 0..60 {
            file.push_str(
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"work\"}}\n",
            );
        }
        // The display name is appended at the very end.
        file.push_str("{\"type\":\"session_info\",\"name\":\"Generated title\"}\n");
        fs::write(sessions.join("long.jsonl"), file).unwrap();

        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)]))
            .unwrap()
            .with_session_root(temp.join("sessions"));

        let all = data.list_all_sessions("workspace-a").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "session-a");
        assert_eq!(all[0].name.as_deref(), Some("Generated title"));
        assert_eq!(all[0].first_message.as_deref(), Some("first turn"));
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
    fn builds_cost_dashboard_across_all_projects() {
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
        // Both projects are aggregated, not just the registered workspace.
        assert_eq!(dashboard.summary.session_count, 2);
        assert_eq!(dashboard.summary.total_cost, 99.5);
        assert_eq!(dashboard.summary.total_tokens, 30);
        assert_eq!(dashboard.by_model[0].name, "gpt-5");
        assert_eq!(dashboard.by_tool[0].name, "bash");
        // The most expensive session sorts first.
        assert_eq!(dashboard.top_sessions[0].id, "session-b");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn opens_convertible_preview_input_inside_the_registered_workspace() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("picot-host-document-{nonce}"));
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("report.docx"), b"document bytes").unwrap();
        let data = HostDataPlane::new(HashMap::from([("workspace-a".into(), workspace)])).unwrap();

        let source = data
            .read_convertible_file("workspace-a", "report.docx")
            .unwrap()
            .unwrap();
        assert_eq!(source.suffix, "docx");
        assert_eq!(source.bytes, b"document bytes");
        assert!(data
            .read_convertible_file("workspace-a", "notes.csv")
            .unwrap()
            .is_none());
        fs::remove_dir_all(temp).unwrap();
    }
}
