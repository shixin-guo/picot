# Unnecessary-Complexity Review

Files reviewed: `src-tauri/src/pi_manager.rs`, `src-tauri/src/main.rs`  
Date: 2026-05-30  
Scope: accidental complexity, over-engineering, redundancy, dead code, verbose patterns.  
Not in scope: correctness bugs, test coverage.

---

## Findings (prioritised: highest impact first)

---

### 1. Hand-rolled JSON extraction instead of `serde_json` (high)

**File:** `pi_manager.rs` lines 36–59 (`locked_pi_version`)

The function manually parses `{"version": "0.77.0"}` with six consecutive
`find` calls and slicing, producing code that is harder to read and maintain
than a one-liner.  The comment says this avoids a dependency, but
`serde_json` is already an unconditional dependency of the whole crate
(used in `send_rpc`, `cmd_new_session`, `cmd_switch_session`, etc.) — so
there is nothing saved.

**Simpler alternative:**
```rust
pub fn locked_pi_version() -> &'static str {
    static CACHED: OnceLock<&'static str> = OnceLock::new();
    CACHED.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(PI_VERSION_JSON)
            .expect("pi-version.json: invalid JSON")
            ["version"]
            .as_str()
            .expect("pi-version.json: \"version\" is not a string")
    })
}
```
Two lines instead of thirteen. The return type can even stay `&'static str`
by leaking the `String`, or the `OnceLock<String>` pattern is kept — either
way it is dramatically shorter.

---

### 2. Redundant `Arc` wrapping inside `PiManager` (medium)

**File:** `pi_manager.rs` line 14; `main.rs` line 17

`PiManager.processes` is `Arc<Mutex<HashMap<…>>>`, but `PiManager` itself is
already stored as `Arc<PiManager>` in Tauri's state (`type PiManagerState =
Arc<PiManager>`).  The interior `Arc` adds a second reference-count
increment/decrement on every lock acquisition for no reason: `PiManager`'s
methods all take `&self`, and the outer `Arc<PiManager>` already keeps the
struct alive for as long as it is referenced.

**Simpler alternative:**  Change the field to `Mutex<HashMap<u16, PiProcess>>`
and remove the inner `Arc::new(…)` in `new()`.

---

### 3. Per-phase `Instant` timers in `cmd_open_workspace` (medium)

**File:** `main.rs` lines 54–101

Five separate `Instant::now()` / `elapsed()` pairs — `started_at`,
`spawn_started_at`, `health_started_at`, `new_session_started_at`,
`sessions_started_at` — track wall-clock time for each phase.
`pi_manager.rs` adds a sixth (`spawn_started_at`, lines 269/283).
Individual phase timers are only informative when there is a profiling need;
for a startup path that is hit once per workspace open they add significant
visual noise.

The total elapsed from `started_at` is the only number that matters for
diagnosing slow launches.  The sub-phase numbers are redundant because
they are consumed by sequential `await` points, so "total − previous phase"
trivially gives each duration anyway.

**Simpler alternative:** Keep only `started_at` in `cmd_open_workspace` and
log `started_at.elapsed()` once at the end.  Remove `spawn_started_at`
from `pi_manager::spawn` (or emit it there only under `debug_assertions`).

---

### 4. `wait_for_health` is a one-line wrapper that never saves typing (low-medium)

**File:** `pi_manager.rs` lines 337–339; `main.rs` line 5

```rust
pub async fn wait_for_health(port: u16, timeout_secs: u64) -> Result<(), String> {
    wait_for_endpoint(port, "/api/health", timeout_secs).await
}
```

`wait_for_health` is called three times in `main.rs`; `wait_for_endpoint`
with `/api/sessions` is called once.  Because the path (`"/api/health"`) is
a compile-time constant, and the callers already import `wait_for_endpoint`
from `pi_manager`, the wrapper adds a public symbol and an import without
reducing any call-site verbosity.

**Simpler alternative:** Delete `wait_for_health`; the three call sites
become `wait_for_endpoint(port, "/api/health", …).await` — one extra token
per call site, zero ambiguity.  Or, if the wrapper is kept for discoverability,
mark it `#[doc(hidden)]` and stop exporting it so it can't leak into the
public API.

---

### 5. Shadow variable `child` in `spawn` (low-medium)

**File:** `pi_manager.rs` lines 253 and 270

```rust
let mut child = Command::new(&pi_bin);   // child: Command
child.args(…).env(…);
…
let mut child = child.spawn(…)?;         // child: Child — shadows the above
```

Reusing the name `child` for two different types (`Command` and `Child`)
makes the code harder to scan.  The original variable in the task description
used `child_builder`, which is clearer.  Alternatively, collapse the builder
into a single expression:

```rust
let mut child = Command::new(&pi_bin)
    .args(&args)
    .current_dir(cwd)
    .env(…)
    …
    .spawn()
    .map_err(|e| format!(…))?;
```

---

### 6. Double `app.handle().clone()` calls (low)

**File:** `main.rs` lines 386 and 405

```rust
open_bootstrap_window(&app.handle().clone(), &err)
…
open_workspace_window(&app.handle().clone(), initial_port)
```

`app` is already `&mut tauri::App`, and `AppHandle` is `Clone`.
`app.handle()` returns a reference to the handle, not an owned handle, so
`.clone()` is needed — but both `open_*` functions accept `&AppHandle`,
meaning passing `app.handle()` directly (no clone) works fine.

```rust
open_bootstrap_window(app.handle(), &err)
open_workspace_window(app.handle(), initial_port)
```

No clone needed; the functions borrow the handle.

---

### 7. Manual URL-encoding of error message (low)

**File:** `main.rs` lines 166–170

```rust
let encoded_error = startup_error
    .replace('&', "%26")
    .replace(' ', "%20")
    .replace('\n', "%0A");
let url = format!("bootstrap.html?startupError={}", encoded_error);
```

This only encodes three characters.  Any `startup_error` containing `=`,
`+`, `#`, `%`, `?`, or non-ASCII will be incorrectly placed in the query
string.  This is also needlessly verbose.

The project already depends on `tauri` and `reqwest`; both transitively
bring in `percent-encoding` or `url` crates.  If a lightweight option is
acceptable, `urlencoding::encode` (a tiny no-dep crate) or the already-
available `url::form_urlencoded` can replace the three-chain replace with
one call.

If a new crate is unwanted, at minimum the comment should note which
characters are not handled rather than implying this is a correct encoder.

---

### 8. `find_latest_session_boot_target` logic duplicated across two callers (low)

**File:** `main.rs`  — the `setup` closure (lines 335–350) and
`cmd_retry_startup` (lines 306–314) both call
`find_latest_session_boot_target()` and then fall back to
`dirs::home_dir().…to_string()` with identical fall-back logic.

**Simpler alternative:** Extract the common pattern into a small helper:

```rust
fn resolve_boot_target() -> (String, Option<String>) {
    let home = dirs::home_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    match find_latest_session_boot_target() {
        Some((cwd, session)) => (cwd, Some(session)),
        None => (home, None),
    }
}
```

Both callers become `let (cwd, session_path) = resolve_boot_target();`,
removing ~10 repeated lines.

---

### 9. `list_session_files` takes `&PathBuf` instead of `&Path` (low / style)

**File:** `main.rs` line 227; same for `extract_session_cwd` line 251.

Taking `&PathBuf` instead of `&Path` forces callers to already own a
`PathBuf` and makes the API unnecessarily narrow.  The Rust idiom for
path parameters is `&Path` (or `impl AsRef<Path>`):

```rust
fn list_session_files(root: &Path) -> Vec<PathBuf> { … }
fn extract_session_cwd(session_path: &Path) -> Option<String> { … }
```

---

### 10. `std::time::Instant` qualified inline while `Instant` is already imported (low / style)

**File:** `pi_manager.rs` lines 347 and 349

```rust
let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
loop {
    if std::time::Instant::now() > deadline {
```

`Instant` is already in scope via `use std::time::{Duration, Instant};`
(line 6).  The fully-qualified path is redundant.

```rust
let deadline = Instant::now() + Duration::from_secs(timeout_secs);
if Instant::now() > deadline {
```

---

## Summary table

| # | Location | Issue | Effort to fix |
|---|----------|-------|---------------|
| 1 | `pi_manager.rs` `locked_pi_version` | Hand-rolled JSON parser vs `serde_json` already in scope | Trivial |
| 2 | `pi_manager.rs` `PiManager.processes` | Inner `Arc` redundant when struct is held behind outer `Arc` | Small |
| 3 | `main.rs` `cmd_open_workspace` | Five per-phase `Instant` timers for a sequential one-shot path | Small |
| 4 | `pi_manager.rs` `wait_for_health` | One-liner wrapper that never saves typing | Trivial |
| 5 | `pi_manager.rs` `spawn` | Variable `child` shadows itself with a different type | Trivial |
| 6 | `main.rs` setup closure | `.handle().clone()` where a borrow suffices | Trivial |
| 7 | `main.rs` `open_bootstrap_window` | Partial URL encoder (3 chars) for error query param | Small |
| 8 | `main.rs` setup + `cmd_retry_startup` | Identical fall-back-to-home logic duplicated | Small |
| 9 | `main.rs` session helpers | `&PathBuf` params instead of idiomatic `&Path` | Trivial |
| 10 | `pi_manager.rs` `wait_for_endpoint` | `std::time::Instant::` qualified while `Instant` is in scope | Trivial |
