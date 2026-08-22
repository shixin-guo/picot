#![cfg_attr(not(test), allow(dead_code))]

use rusqlite::{params, Connection, OptionalExtension, Row};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 2;

/// How often a scheduled task repeats. Deliberately simple — no cron
/// expressions, just four fixed cadences anchored at `anchor_at`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskFrequency {
    Once,
    Hourly,
    Daily,
    Weekly,
}

impl TaskFrequency {
    fn as_str(self) -> &'static str {
        match self {
            TaskFrequency::Once => "once",
            TaskFrequency::Hourly => "hourly",
            TaskFrequency::Daily => "daily",
            TaskFrequency::Weekly => "weekly",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "once" => Ok(TaskFrequency::Once),
            "hourly" => Ok(TaskFrequency::Hourly),
            "daily" => Ok(TaskFrequency::Daily),
            "weekly" => Ok(TaskFrequency::Weekly),
            other => Err(format!("Unknown scheduled task frequency: {other}")),
        }
    }

    fn period_seconds(self) -> Option<i64> {
        match self {
            TaskFrequency::Once => None,
            TaskFrequency::Hourly => Some(3600),
            TaskFrequency::Daily => Some(86_400),
            TaskFrequency::Weekly => Some(604_800),
        }
    }
}

/// Lifecycle status of a scheduled task's most recent (or in-flight) run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Running,
    Success,
    Failed,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::Running => "running",
            TaskStatus::Success => "success",
            TaskStatus::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(TaskStatus::Pending),
            "running" => Ok(TaskStatus::Running),
            "success" => Ok(TaskStatus::Success),
            "failed" => Ok(TaskStatus::Failed),
            other => Err(format!("Unknown scheduled task status: {other}")),
        }
    }
}

/// A scheduled task: a workspace + prompt + cadence + optional model. When
/// due, Picot spawns a headless pi run of `prompt` in the workspace; the
/// result is a normal Picot session (`last_session_id`) the user can open.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub workspace_id: String,
    pub prompt: String,
    /// Model id to `set_model` before running, e.g. "claude-haiku-4-5".
    /// `None` means "use the workspace's default model".
    pub model: Option<String>,
    pub frequency: TaskFrequency,
    /// Unix seconds: for `once`, the single run time; for repeating
    /// cadences, the reference point future occurrences are computed from.
    pub anchor_at: i64,
    pub enabled: bool,
    pub status: TaskStatus,
    pub last_session_id: Option<String>,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub retry_count: i64,
    pub created_at: i64,
}

/// Patch for updating a scheduled task; `None` fields are left unchanged.
/// `model` uses double-Option so callers can explicitly clear it back to
/// "use workspace default" by passing `Some(None)`.
#[derive(Debug, Default, Clone)]
pub struct ScheduledTaskPatch {
    pub prompt: Option<String>,
    pub model: Option<Option<String>>,
    pub frequency: Option<TaskFrequency>,
    pub anchor_at: Option<i64>,
    pub enabled: Option<bool>,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// First occurrence of `frequency` (anchored at `anchor_at`) strictly after
/// `after`, or the anchor itself when it is still in the future. `Once`
/// tasks never advance past their anchor: this returns `None` once
/// `anchor_at <= after`, since a one-off has nothing left to schedule.
pub fn advance_next_run_at(frequency: TaskFrequency, anchor_at: i64, after: i64) -> Option<i64> {
    match frequency.period_seconds() {
        None => {
            if anchor_at > after {
                Some(anchor_at)
            } else {
                None
            }
        }
        Some(period) => {
            if anchor_at > after {
                return Some(anchor_at);
            }
            let elapsed = after - anchor_at;
            let periods_passed = elapsed / period + 1;
            Some(anchor_at + periods_passed * period)
        }
    }
}

fn scheduled_task_from_row(row: &Row) -> rusqlite::Result<ScheduledTask> {
    let frequency: String = row.get("frequency")?;
    let status: String = row.get("status")?;
    Ok(ScheduledTask {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        prompt: row.get("prompt")?,
        model: row.get("model")?,
        frequency: TaskFrequency::parse(&frequency)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        anchor_at: row.get("anchor_at")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        status: TaskStatus::parse(&status).map_err(|_| rusqlite::Error::InvalidQuery)?,
        last_session_id: row.get("last_session_id")?,
        last_run_at: row.get("last_run_at")?,
        next_run_at: row.get("next_run_at")?,
        retry_count: row.get("retry_count")?,
        created_at: row.get("created_at")?,
    })
}

const SCHEDULED_TASK_COLUMNS: &str = "id, workspace_id, prompt, model, frequency, anchor_at, \
     enabled, status, last_session_id, last_run_at, next_run_at, retry_count, created_at";

pub struct MetadataStore {
    connection: Connection,
    path: PathBuf,
}

impl MetadataStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create Picot metadata directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let connection = Connection::open(path).map_err(|error| {
            format!(
                "Cannot open Picot metadata database {}: {error}",
                path.display()
            )
        })?;
        let mut store = Self {
            connection,
            path: path.to_path_buf(),
        };
        store.migrate()?;
        store.restrict_permissions()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<(), String> {
        let current: i64 = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("Cannot read Picot metadata schema version: {error}"))?;
        if current > SCHEMA_VERSION {
            return Err(format!(
                "Picot metadata schema {current} is newer than supported schema {SCHEMA_VERSION}"
            ));
        }
        if current == SCHEMA_VERSION {
            return Ok(());
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start Picot metadata migration: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS workspaces (
                    workspace_id TEXT PRIMARY KEY,
                    canonical_path TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE TABLE IF NOT EXISTS paired_devices (
                    device_id TEXT PRIMARY KEY,
                    token_hash BLOB NOT NULL UNIQUE,
                    paired_at INTEGER NOT NULL DEFAULT (unixepoch()),
                    revoked_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS preferences (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS scheduled_tasks (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    model TEXT,
                    frequency TEXT NOT NULL,
                    anchor_at INTEGER NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    status TEXT NOT NULL DEFAULT 'pending',
                    last_session_id TEXT,
                    last_run_at INTEGER,
                    next_run_at INTEGER,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE INDEX IF NOT EXISTS scheduled_tasks_workspace_idx
                    ON scheduled_tasks (workspace_id);
                PRAGMA user_version = 2;",
            )
            .map_err(|error| format!("Cannot migrate Picot metadata schema: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Picot metadata migration: {error}"))
    }

    #[cfg(unix)]
    fn restrict_permissions(&self) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "Cannot restrict metadata permissions {}: {error}",
                    self.path.display()
                )
            },
        )
    }

    #[cfg(not(unix))]
    fn restrict_permissions(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64, String> {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("Cannot read Picot metadata schema version: {error}"))
    }

    pub fn workspace_id_for_path(&mut self, workspace: &Path) -> Result<String, String> {
        let canonical = workspace.canonicalize().map_err(|error| {
            format!("Cannot resolve workspace {}: {error}", workspace.display())
        })?;
        let canonical = canonical.to_string_lossy();
        if let Some(id) = self
            .connection
            .query_row(
                "SELECT workspace_id FROM workspaces WHERE canonical_path = ?1",
                [canonical.as_ref()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot query workspace metadata: {error}"))?
        {
            return Ok(id);
        }
        let id = Uuid::new_v4().to_string();
        self.connection
            .execute(
                "INSERT INTO workspaces (workspace_id, canonical_path) VALUES (?1, ?2)",
                params![id, canonical.as_ref()],
            )
            .map_err(|error| format!("Cannot store workspace metadata: {error}"))?;
        Ok(id)
    }

    pub fn store_device_token(&mut self, device_id: &str, token: &str) -> Result<(), String> {
        let token_hash = token_hash(token);
        self.connection
            .execute(
                "INSERT INTO paired_devices (device_id, token_hash, revoked_at)
                 VALUES (?1, ?2, NULL)
                 ON CONFLICT(device_id) DO UPDATE SET
                   token_hash = excluded.token_hash,
                   paired_at = unixepoch(),
                   revoked_at = NULL",
                params![device_id, token_hash],
            )
            .map_err(|error| format!("Cannot store paired device: {error}"))?;
        Ok(())
    }

    pub fn verify_device_token(&self, token: &str) -> Result<bool, String> {
        let token_hash = token_hash(token);
        self.connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM paired_devices WHERE token_hash = ?1 AND revoked_at IS NULL
                )",
                [token_hash],
                |row| row.get(0),
            )
            .map_err(|error| format!("Cannot verify paired device: {error}"))
    }

    pub fn revoke_device(&mut self, device_id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE paired_devices SET revoked_at = unixepoch() WHERE device_id = ?1",
                [device_id],
            )
            .map_err(|error| format!("Cannot revoke paired device: {error}"))?;
        Ok(())
    }

    /// Create a scheduled task and compute its first `next_run_at`.
    pub fn create_scheduled_task(
        &mut self,
        workspace_id: &str,
        prompt: &str,
        model: Option<&str>,
        frequency: TaskFrequency,
        anchor_at: i64,
    ) -> Result<ScheduledTask, String> {
        let id = Uuid::new_v4().to_string();
        let created_at = now_unix();
        // A freshly created task's first run is simply its anchor: if the
        // anchor is already in the past (e.g. "daily at 9am" created at
        // 10am), it is due immediately rather than waiting a full period —
        // the startup catch-up pass exists for exactly this kind of gap.
        let next_run_at = Some(anchor_at);
        self.connection
            .execute(
                "INSERT INTO scheduled_tasks
                    (id, workspace_id, prompt, model, frequency, anchor_at, enabled, status,
                     last_session_id, last_run_at, next_run_at, retry_count, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'pending', NULL, NULL, ?7, 0, ?8)",
                params![
                    id,
                    workspace_id,
                    prompt,
                    model,
                    frequency.as_str(),
                    anchor_at,
                    next_run_at,
                    created_at
                ],
            )
            .map_err(|error| format!("Cannot create scheduled task: {error}"))?;
        self.get_scheduled_task(&id)?
            .ok_or_else(|| "Scheduled task vanished after insert".to_string())
    }

    pub fn list_scheduled_tasks(&self, workspace_id: &str) -> Result<Vec<ScheduledTask>, String> {
        let sql = format!(
            "SELECT {SCHEDULED_TASK_COLUMNS} FROM scheduled_tasks
             WHERE workspace_id = ?1 ORDER BY created_at DESC"
        );
        let mut statement = self
            .connection
            .prepare(&sql)
            .map_err(|error| format!("Cannot list scheduled tasks: {error}"))?;
        let rows = statement
            .query_map([workspace_id], scheduled_task_from_row)
            .map_err(|error| format!("Cannot list scheduled tasks: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot read scheduled tasks: {error}"))
    }

    pub fn get_scheduled_task(&self, id: &str) -> Result<Option<ScheduledTask>, String> {
        let sql = format!("SELECT {SCHEDULED_TASK_COLUMNS} FROM scheduled_tasks WHERE id = ?1");
        self.connection
            .query_row(&sql, [id], scheduled_task_from_row)
            .optional()
            .map_err(|error| format!("Cannot read scheduled task: {error}"))
    }

    pub fn update_scheduled_task(
        &mut self,
        id: &str,
        patch: ScheduledTaskPatch,
    ) -> Result<ScheduledTask, String> {
        let existing = self
            .get_scheduled_task(id)?
            .ok_or_else(|| "Scheduled task not found".to_string())?;
        let prompt = patch.prompt.unwrap_or(existing.prompt);
        let model = patch.model.unwrap_or(existing.model);
        let frequency = patch.frequency.unwrap_or(existing.frequency);
        let anchor_at = patch.anchor_at.unwrap_or(existing.anchor_at);
        let enabled = patch.enabled.unwrap_or(existing.enabled);
        // Re-anchoring the schedule (frequency/anchor changed) restarts the
        // cadence from "now" rather than keeping a next_run_at computed
        // against the old anchor.
        let next_run_at = Some(anchor_at);
        self.connection
            .execute(
                "UPDATE scheduled_tasks SET
                    prompt = ?1, model = ?2, frequency = ?3, anchor_at = ?4,
                    enabled = ?5, next_run_at = ?6
                 WHERE id = ?7",
                params![
                    prompt,
                    model,
                    frequency.as_str(),
                    anchor_at,
                    enabled as i64,
                    next_run_at,
                    id
                ],
            )
            .map_err(|error| format!("Cannot update scheduled task: {error}"))?;
        self.get_scheduled_task(id)?
            .ok_or_else(|| "Scheduled task vanished after update".to_string())
    }

    pub fn delete_scheduled_task(&mut self, id: &str) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM scheduled_tasks WHERE id = ?1", [id])
            .map_err(|error| format!("Cannot delete scheduled task: {error}"))?;
        Ok(())
    }

    /// Tasks currently due to run: enabled, not already running, whose next
    /// scheduled time has arrived. Polled by the scheduler loop.
    pub fn due_scheduled_tasks(&self, now: i64) -> Result<Vec<ScheduledTask>, String> {
        let sql = format!(
            "SELECT {SCHEDULED_TASK_COLUMNS} FROM scheduled_tasks
             WHERE enabled = 1 AND status != 'running'
               AND next_run_at IS NOT NULL AND next_run_at <= ?1
             ORDER BY next_run_at ASC"
        );
        let mut statement = self
            .connection
            .prepare(&sql)
            .map_err(|error| format!("Cannot query due scheduled tasks: {error}"))?;
        let rows = statement
            .query_map([now], scheduled_task_from_row)
            .map_err(|error| format!("Cannot query due scheduled tasks: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot read due scheduled tasks: {error}"))
    }

    /// One-time startup catch-up set: tasks that failed and are still under
    /// the retry cap, plus enabled tasks whose run time already passed
    /// (missed because the app was closed). Deliberately NOT re-polled on a
    /// timer — this only runs once at startup; see `due_scheduled_tasks` for
    /// the regular schedule.
    pub fn catch_up_scheduled_tasks(
        &self,
        now: i64,
        retry_cap: i64,
    ) -> Result<Vec<ScheduledTask>, String> {
        let sql = format!(
            "SELECT {SCHEDULED_TASK_COLUMNS} FROM scheduled_tasks
             WHERE (status = 'failed' AND retry_count < ?2)
                OR (enabled = 1 AND status != 'running'
                    AND next_run_at IS NOT NULL AND next_run_at <= ?1)
             ORDER BY next_run_at ASC"
        );
        let mut statement = self
            .connection
            .prepare(&sql)
            .map_err(|error| format!("Cannot query catch-up scheduled tasks: {error}"))?;
        let rows = statement
            .query_map(params![now, retry_cap], scheduled_task_from_row)
            .map_err(|error| format!("Cannot query catch-up scheduled tasks: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot read catch-up scheduled tasks: {error}"))
    }

    pub fn mark_scheduled_task_running(&mut self, id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE scheduled_tasks SET status = 'running' WHERE id = ?1",
                [id],
            )
            .map_err(|error| format!("Cannot mark scheduled task running: {error}"))?;
        Ok(())
    }

    /// Record a finished run. `next_run_at` always advances (even on
    /// failure) so a repeating task keeps its cadence instead of turning
    /// into a background retry loop; only the startup catch-up pass retries
    /// a failed run, and only up to `retry_count`'s cap.
    pub fn mark_scheduled_task_finished(
        &mut self,
        id: &str,
        success: bool,
        session_id: Option<&str>,
    ) -> Result<(), String> {
        let task = self
            .get_scheduled_task(id)?
            .ok_or_else(|| "Scheduled task not found".to_string())?;
        let now = now_unix();
        let next_run_at = advance_next_run_at(task.frequency, task.anchor_at, now);
        let status = if success {
            TaskStatus::Success
        } else {
            TaskStatus::Failed
        };
        let retry_count = if success { 0 } else { task.retry_count + 1 };
        self.connection
            .execute(
                "UPDATE scheduled_tasks SET
                    status = ?1, last_run_at = ?2, next_run_at = ?3, retry_count = ?4,
                    last_session_id = COALESCE(?5, last_session_id)
                 WHERE id = ?6",
                params![
                    status.as_str(),
                    now,
                    next_run_at,
                    retry_count,
                    session_id,
                    id
                ],
            )
            .map_err(|error| format!("Cannot record scheduled task result: {error}"))?;
        Ok(())
    }

    /// Manual "run now" / retry: always allowed regardless of retry_count,
    /// and resets it so a manually-kicked task doesn't immediately look
    /// exhausted again.
    pub fn reset_scheduled_task_for_manual_run(&mut self, id: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE scheduled_tasks SET retry_count = 0 WHERE id = ?1",
                [id],
            )
            .map_err(|error| format!("Cannot reset scheduled task retry count: {error}"))?;
        Ok(())
    }

    pub fn reset(&mut self) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Cannot start metadata reset: {error}"))?;
        transaction
            .execute_batch(
                "DELETE FROM workspaces; DELETE FROM paired_devices; DELETE FROM preferences;
                 DELETE FROM scheduled_tasks;",
            )
            .map_err(|error| format!("Cannot reset Picot metadata: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Picot metadata reset: {error}"))
    }
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::{
        advance_next_run_at, now_unix, MetadataStore, ScheduledTaskPatch, TaskFrequency,
        TaskStatus,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("picot-metadata-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn assigns_stable_workspace_ids_and_stores_only_device_token_hashes() {
        let temp = temp_dir();
        let database = temp.join("picot.sqlite3");
        let workspace = temp.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let mut store = MetadataStore::open(&database).unwrap();

        let first = store.workspace_id_for_path(&workspace).unwrap();
        let second = store.workspace_id_for_path(&workspace).unwrap();
        assert_eq!(first, second);
        assert_eq!(store.schema_version().unwrap(), 2);

        store
            .store_device_token("phone", "plain-device-token")
            .unwrap();
        assert!(store.verify_device_token("plain-device-token").unwrap());
        assert!(!store.verify_device_token("wrong-token").unwrap());
        let bytes = fs::read(&database).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("plain-device-token"));
        store.revoke_device("phone").unwrap();
        assert!(!store.verify_device_token("plain-device-token").unwrap());

        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reset_cannot_modify_pi_sessions_or_workspace_files() {
        let temp = temp_dir();
        let database = temp.join("picot.sqlite3");
        let workspace = temp.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let session = workspace.join("session.jsonl");
        fs::write(&session, "{\"type\":\"session\"}\n").unwrap();
        let mut store = MetadataStore::open(&database).unwrap();
        store.workspace_id_for_path(&workspace).unwrap();

        store.reset().unwrap();

        assert_eq!(
            fs::read_to_string(session).unwrap(),
            "{\"type\":\"session\"}\n"
        );
        assert_eq!(store.schema_version().unwrap(), 2);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn migrates_a_v1_database_without_losing_existing_data() {
        let temp = temp_dir();
        let database = temp.join("picot.sqlite3");
        {
            let connection = rusqlite::Connection::open(&database).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE workspaces (
                        workspace_id TEXT PRIMARY KEY,
                        canonical_path TEXT NOT NULL UNIQUE,
                        created_at INTEGER NOT NULL DEFAULT (unixepoch())
                    );
                    CREATE TABLE paired_devices (
                        device_id TEXT PRIMARY KEY,
                        token_hash BLOB NOT NULL UNIQUE,
                        paired_at INTEGER NOT NULL DEFAULT (unixepoch()),
                        revoked_at INTEGER
                    );
                    CREATE TABLE preferences (
                        key TEXT PRIMARY KEY,
                        value_json TEXT NOT NULL
                    );
                    INSERT INTO workspaces (workspace_id, canonical_path) VALUES ('w1', '/tmp/w1');
                    PRAGMA user_version = 1;",
                )
                .unwrap();
        }
        let mut store = MetadataStore::open(&database).unwrap();
        assert_eq!(store.schema_version().unwrap(), 2);
        let id: String = store
            .connection
            .query_row(
                "SELECT workspace_id FROM workspaces WHERE canonical_path = '/tmp/w1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(id, "w1");
        // The new table exists and is usable after migrating from v1.
        let task = store
            .create_scheduled_task("w1", "do the thing", None, TaskFrequency::Once, 1_000)
            .unwrap();
        assert_eq!(task.workspace_id, "w1");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn computes_next_run_at_for_each_frequency() {
        // Once: due when in the past, nothing left once it has run.
        assert_eq!(advance_next_run_at(TaskFrequency::Once, 100, 50), Some(100));
        assert_eq!(advance_next_run_at(TaskFrequency::Once, 100, 100), None);
        assert_eq!(advance_next_run_at(TaskFrequency::Once, 100, 200), None);

        // Hourly: anchor in the future stays put; otherwise jump to the next
        // hour boundary strictly after `after`.
        assert_eq!(
            advance_next_run_at(TaskFrequency::Hourly, 1_000, 500),
            Some(1_000)
        );
        assert_eq!(
            advance_next_run_at(TaskFrequency::Hourly, 1_000, 1_000),
            Some(1_000 + 3_600)
        );
        assert_eq!(
            advance_next_run_at(TaskFrequency::Hourly, 1_000, 1_000 + 3_600 * 5 + 10),
            Some(1_000 + 3_600 * 6)
        );

        // Daily / weekly follow the same shape with their own period.
        assert_eq!(
            advance_next_run_at(TaskFrequency::Daily, 0, 86_400),
            Some(86_400 * 2)
        );
        assert_eq!(
            advance_next_run_at(TaskFrequency::Weekly, 0, 604_800),
            Some(604_800 * 2)
        );
    }

    #[test]
    fn crud_round_trips_a_scheduled_task_and_computes_status_transitions() {
        let temp = temp_dir();
        let database = temp.join("picot.sqlite3");
        let mut store = MetadataStore::open(&database).unwrap();

        let created = store
            .create_scheduled_task(
                "workspace-a",
                "Summarize open PRs",
                Some("claude-haiku-4-5"),
                TaskFrequency::Daily,
                1_000,
            )
            .unwrap();
        assert_eq!(created.status, TaskStatus::Pending);
        assert_eq!(created.next_run_at, Some(1_000));
        assert_eq!(created.retry_count, 0);

        let listed = store.list_scheduled_tasks("workspace-a").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        let updated = store
            .update_scheduled_task(
                &created.id,
                ScheduledTaskPatch {
                    prompt: Some("Summarize open PRs and flag stale ones".to_string()),
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.prompt, "Summarize open PRs and flag stale ones");
        assert!(!updated.enabled);

        store.mark_scheduled_task_running(&created.id).unwrap();
        let running = store.get_scheduled_task(&created.id).unwrap().unwrap();
        assert_eq!(running.status, TaskStatus::Running);

        store
            .mark_scheduled_task_finished(&created.id, true, Some("session-123"))
            .unwrap();
        let done = store.get_scheduled_task(&created.id).unwrap().unwrap();
        assert_eq!(done.status, TaskStatus::Success);
        assert_eq!(done.last_session_id.as_deref(), Some("session-123"));
        assert_eq!(done.retry_count, 0);
        assert!(done.next_run_at.unwrap() > done.last_run_at.unwrap());

        store.delete_scheduled_task(&created.id).unwrap();
        assert!(store.get_scheduled_task(&created.id).unwrap().is_none());

        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn failed_runs_increment_retry_count_and_catch_up_selects_capped_failures() {
        let temp = temp_dir();
        let database = temp.join("picot.sqlite3");
        let mut store = MetadataStore::open(&database).unwrap();

        let task = store
            .create_scheduled_task("workspace-a", "run tests", None, TaskFrequency::Once, 1_000)
            .unwrap();

        for expected_retry in 1..=3 {
            store.mark_scheduled_task_running(&task.id).unwrap();
            store
                .mark_scheduled_task_finished(&task.id, false, None)
                .unwrap();
            let refreshed = store.get_scheduled_task(&task.id).unwrap().unwrap();
            assert_eq!(refreshed.status, TaskStatus::Failed);
            assert_eq!(refreshed.retry_count, expected_retry);
        }

        let now = now_unix() + 10;
        // retry_cap = 3: a task with retry_count == 3 is no longer picked up.
        let catch_up = store.catch_up_scheduled_tasks(now, 3).unwrap();
        assert!(catch_up.iter().all(|t| t.id != task.id));
        let catch_up = store.catch_up_scheduled_tasks(now, 4).unwrap();
        assert!(catch_up.iter().any(|t| t.id == task.id));

        // Manual run-now always resets the counter regardless of the cap.
        store
            .reset_scheduled_task_for_manual_run(&task.id)
            .unwrap();
        let reset = store.get_scheduled_task(&task.id).unwrap().unwrap();
        assert_eq!(reset.retry_count, 0);

        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn catch_up_also_selects_enabled_tasks_missed_while_the_app_was_closed() {
        let temp = temp_dir();
        let database = temp.join("picot.sqlite3");
        let mut store = MetadataStore::open(&database).unwrap();

        let past_due = store
            .create_scheduled_task("workspace-a", "missed task", None, TaskFrequency::Daily, 1)
            .unwrap();
        let future = store
            .create_scheduled_task(
                "workspace-a",
                "future task",
                None,
                TaskFrequency::Daily,
                now_unix() + 10_000,
            )
            .unwrap();

        let now = now_unix();
        let catch_up = store.catch_up_scheduled_tasks(now, 3).unwrap();
        assert!(catch_up.iter().any(|t| t.id == past_due.id));
        assert!(catch_up.iter().all(|t| t.id != future.id));

        let due = store.due_scheduled_tasks(now).unwrap();
        assert!(due.iter().any(|t| t.id == past_due.id));

        fs::remove_dir_all(temp).unwrap();
    }
}
