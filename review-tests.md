# Test Coverage Review — `pi_manager.rs` + `main.rs`

**Reviewed:** `src-tauri/src/pi_manager.rs`, `src-tauri/src/main.rs`  
**Date:** 2026-05-30

---

## Correct (already good)

- **Zero tests exist** — this is the starting point, not a criticism of what was
  written. The code itself is structurally clean and most pure functions are
  testable in isolation without Tauri.
- `locked_pi_version`, `list_session_files`, `extract_session_cwd`,
  `is_port_in_use`, and `next_port` have no I/O side-effects beyond what can
  be faked in a test module — they are the best bang-for-buck targets.
- The `PiManager` struct holds no global state; tests can construct isolated
  instances with a temp `static_dir`, so process-management tests are
  feasible without mocking infrastructure.

---

## What Is Not Tested (full inventory)

| Function / behaviour | Testable without live pi? | Notes |
|---|---|---|
| `locked_pi_version` | ✅ yes | Purely string parsing on a compile-time literal |
| `list_session_files` | ✅ yes (tempdir) | Pure fs walk |
| `extract_session_cwd` | ✅ yes (in-memory file) | Pure file parsing |
| `find_latest_session_boot_target` | ✅ yes (tempdir) | Depends on `dirs::home_dir` — see note below |
| `is_port_in_use` | ✅ yes | Bind a real listener, then check |
| `PiManager::next_port` | ✅ yes | Inspect map + `is_port_in_use` |
| `PiManager::kill` / `kill_all` | ✅ yes (spawn `sleep`) | Spawns a dummy process |
| `PiManager::send_rpc` | ✅ yes (spawn `cat`) | Writes to stdin; check via stdout |
| `PiManager::resolve_bundled_pi` | ✅ yes (tempdir + env) | Tests path-resolution logic |
| `PiManager::resolve_embedded_extension_path` | ✅ yes (tempdir + env) | Same shape as above |
| `PiManager::spawn` | ⚠️ needs real pi binary | Integration-only |
| `wait_for_endpoint` | ⚠️ needs live HTTP server | Integration-only |
| `open_workspace_window` / `open_bootstrap_window` | ❌ needs Tauri runtime | Untestable in unit tests |
| `find_static_dir` | ❌ needs Tauri `App` | Untestable in unit tests |
| `on_window_event` kill-on-destroy | ❌ needs Tauri runtime | Untestable in unit tests |

---

## Prioritised Missing Tests

### Priority 1 — Pure parsing functions (zero infrastructure needed)

---

#### T-1  `locked_pi_version` — nominal parse

The most critical function to have tested: it `panic!`s at runtime if the
JSON shape changes, and the panic text is shown to the user as a startup
crash.

```rust
#[cfg(test)]
mod tests {
    use super::locked_pi_version;

    #[test]
    fn locked_pi_version_parses_expected_format() {
        // The compile-time literal is {"version":"0.77.0",...}
        let v = locked_pi_version();
        // Must be non-empty and not contain whitespace / quotes.
        assert!(!v.is_empty());
        assert!(!v.contains('"'));
        // Semver-ish: at least one dot.
        assert!(v.contains('.'), "version '{}' should look like semver", v);
    }
}
```

**Why high priority:** any future reformatting of `scripts/pi-version.json`
(e.g. pretty-printing, reordering keys) will cause a production crash with
zero compile-time warning. This test would catch it immediately.

---

#### T-2  `locked_pi_version` — regression: spaces around colon / value

The hand-rolled parser handles `"version": " 0.77.0 "` — verify it strips
correctly. This requires a separate helper that accepts an input string, or
exposing the inner logic. The simplest approach is a small `parse_version_from`
helper factored out of `locked_pi_version`:

```rust
// Suggested refactor: extract inner logic so it's directly testable
fn parse_version_from(json: &str) -> Option<String> { ... }

#[test]
fn parse_version_handles_spaces_around_colon() {
    assert_eq!(parse_version_from(r#"{ "version" : "1.2.3" }"#).as_deref(), Some("1.2.3"));
}

#[test]
fn parse_version_handles_extra_fields() {
    assert_eq!(
        parse_version_from(r#"{"_comment":"x","version":"2.0.0"}"#).as_deref(),
        Some("2.0.0")
    );
}

#[test]
fn parse_version_returns_none_on_missing_key() {
    assert!(parse_version_from(r#"{"other":"x"}"#).is_none());
}
```

**Currently `locked_pi_version` panics instead of returning `Option`.**  
The tests above represent what the refactored form would look like; the
panic-on-bad-json is acceptable for a compile-time string, but the extra
fields test is still worth wiring up against the public function with a
well-formed input.

---

#### T-3  `extract_session_cwd` — core parse cases

```rust
use std::io::Write;
use tempfile::NamedTempFile;

fn write_session_file(lines: &[&str]) -> PathBuf {
    let mut f = NamedTempFile::new().unwrap();
    for line in lines { writeln!(f, "{}", line).unwrap(); }
    f.into_temp_path().to_path_buf()
}

#[test]
fn extract_cwd_returns_cwd_from_session_record() {
    let path = write_session_file(&[
        r#"{"type":"message","role":"user","content":"hi"}"#,
        r#"{"type":"session","cwd":"/home/alice/project","model":"x"}"#,
    ]);
    assert_eq!(extract_session_cwd(&path), Some("/home/alice/project".into()));
}

#[test]
fn extract_cwd_returns_first_session_record() {
    // Only the FIRST matching record should be returned
    let path = write_session_file(&[
        r#"{"type":"session","cwd":"/first"}"#,
        r#"{"type":"session","cwd":"/second"}"#,
    ]);
    assert_eq!(extract_session_cwd(&path), Some("/first".into()));
}

#[test]
fn extract_cwd_returns_none_when_no_session_record() {
    let path = write_session_file(&[
        r#"{"type":"message","role":"user","content":"hello"}"#,
    ]);
    assert_eq!(extract_session_cwd(&path), None);
}

#[test]
fn extract_cwd_returns_none_for_empty_cwd() {
    let path = write_session_file(&[
        r#"{"type":"session","cwd":""}"#,
    ]);
    assert_eq!(extract_session_cwd(&path), None);
}

#[test]
fn extract_cwd_skips_invalid_json_lines() {
    let path = write_session_file(&[
        "not-json",
        r#"{"type":"session","cwd":"/valid"}"#,
    ]);
    assert_eq!(extract_session_cwd(&path), Some("/valid".into()));
}

#[test]
fn extract_cwd_returns_none_for_nonexistent_file() {
    let path = PathBuf::from("/this/does/not/exist/session.jsonl");
    assert_eq!(extract_session_cwd(&path), None);
}

#[test]
fn extract_cwd_respects_200_line_limit() {
    // session record is on line 201 — should NOT be found
    let mut lines: Vec<&str> = vec![r#"{"type":"message"}"#; 200];
    let session_line = r#"{"type":"session","cwd":"/late"}"#;
    lines.push(session_line);
    let path = write_session_file(&lines);
    assert_eq!(extract_session_cwd(&path), None);
}
```

**Why high priority:** `extract_session_cwd` drives auto-resume on startup.
A silent `None` causes the wrong workspace to open; a panic would crash the
app. The 200-line boundary and empty-string guard are easy to regress.

---

#### T-4  `list_session_files` — directory walk

```rust
use tempfile::TempDir;
use std::fs;

fn make_session_tree(root: &TempDir, layout: &[(&str, &str)]) {
    // layout: &[(subdir, filename)]
    for (subdir, name) in layout {
        let dir = root.path().join(subdir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(name), "").unwrap();
    }
}

#[test]
fn list_session_files_collects_jsonl_files() {
    let dir = TempDir::new().unwrap();
    make_session_tree(&dir, &[
        ("abc123", "session.jsonl"),
        ("def456", "session.jsonl"),
    ]);
    let files = list_session_files(&dir.path().to_path_buf());
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl")));
}

#[test]
fn list_session_files_ignores_non_jsonl() {
    let dir = TempDir::new().unwrap();
    make_session_tree(&dir, &[
        ("abc123", "session.jsonl"),
        ("abc123", "session.txt"),
        ("abc123", "session.json"),
    ]);
    let files = list_session_files(&dir.path().to_path_buf());
    assert_eq!(files.len(), 1);
}

#[test]
fn list_session_files_ignores_top_level_jsonl() {
    // Files directly under root (not in a subdir) must be skipped —
    // the structure is root/<subdir>/*.jsonl, matching pi's session layout.
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("toplevel.jsonl"), "").unwrap();
    make_session_tree(&dir, &[("sub", "real.jsonl")]);
    let files = list_session_files(&dir.path().to_path_buf());
    assert_eq!(files.len(), 1);
    assert!(files[0].to_string_lossy().contains("sub"));
}

#[test]
fn list_session_files_returns_empty_for_missing_root() {
    let path = PathBuf::from("/no/such/directory");
    assert!(list_session_files(&path).is_empty());
}

#[test]
fn list_session_files_returns_empty_for_empty_root() {
    let dir = TempDir::new().unwrap();
    assert!(list_session_files(&dir.path().to_path_buf()).is_empty());
}
```

**Why high priority:** wrong session file collection silently resumes the
wrong session on startup. The "top-level jsonl is ignored" case is a
subtle invariant that matches pi's actual on-disk layout and is invisible
from reading the function signature.

---

### Priority 2 — `PiManager` state / map operations (needs dummy process)

---

#### T-5  `is_port_in_use` — with a live listener

```rust
#[test]
fn is_port_in_use_returns_true_when_bound() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // Listener is still open — bind should fail
    assert!(is_port_in_use(port));
    drop(listener);
    // After drop, port should be free
    assert!(!is_port_in_use(port));
}

#[test]
fn is_port_in_use_returns_false_for_free_port() {
    // Find a free port, then immediately check it
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener); // release before check
    assert!(!is_port_in_use(port));
}
```

**Caveat:** there is an inherent TOCTOU race between `drop(listener)` and
`is_port_in_use`, but in practice this is fine for unit testing on loopback
with ephemeral ports.

---

#### T-6  `PiManager::next_port` — map-driven allocation

```rust
#[test]
fn next_port_starts_at_3001_when_map_empty_and_port_free() {
    // Assumes 3001 is not in use on the test host; skip if it is.
    if is_port_in_use(3001) { return; }
    let m = PiManager::new(PathBuf::from("/tmp"));
    assert_eq!(m.next_port(), 3001);
}

#[test]
fn next_port_skips_ports_in_map() {
    // Inject a fake entry: we can't call spawn without a real pi binary,
    // so reach into processes directly via a test-only constructor OR
    // expose an `insert_for_test` method gated on #[cfg(test)].
    //
    // Pseudocode (requires a test helper):
    //   m.processes.lock().unwrap().insert(3001, fake_process());
    //   m.processes.lock().unwrap().insert(3002, fake_process());
    //   assert_eq!(m.next_port(), 3003);  // or 3004 if 3003 is in use
}
```

**Testability note:** `PiManager::processes` is private and `PiProcess` wraps
a real `Child`/`ChildStdin`, so injecting fake entries requires either:

- A `#[cfg(test)] fn insert_dummy_for_test(&self, port: u16)` that spawns
  `sleep 9999` and inserts the `PiProcess`, or
- Splitting `PiProcess` into a trait so a mock can be injected.

The `sleep 9999` approach is simplest and avoids a trait redesign.

---

#### T-7  `PiManager::kill` and `kill_all`

```rust
// Requires the dummy-process helper from T-6.

#[test]
fn kill_removes_port_from_map() {
    let m = PiManager::new(PathBuf::from("/tmp"));
    m.insert_dummy_for_test(3001); // spawns `sleep 9999`
    assert!(m.processes.lock().unwrap().contains_key(&3001));
    m.kill(3001);
    assert!(!m.processes.lock().unwrap().contains_key(&3001));
}

#[test]
fn kill_nonexistent_port_is_noop() {
    let m = PiManager::new(PathBuf::from("/tmp"));
    m.kill(9999); // must not panic
}

#[test]
fn kill_all_clears_map() {
    let m = PiManager::new(PathBuf::from("/tmp"));
    m.insert_dummy_for_test(3001);
    m.insert_dummy_for_test(3002);
    m.kill_all();
    assert!(m.processes.lock().unwrap().is_empty());
}
```

---

#### T-8  `PiManager::send_rpc` — stdin write

```rust
#[test]
fn send_rpc_writes_json_line_to_stdin() {
    // Spawn `cat` (or on Windows `findstr /n .`) with stdin piped
    // and stdout piped; inject as a PiProcess; call send_rpc; read back
    // stdout to verify the line arrived.
    //
    // Pseudocode:
    //   let mut child = Command::new("cat").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
    //   let stdin = child.stdin.take().unwrap();
    //   m.processes.lock().unwrap().insert(3001, PiProcess { child, stdin });
    //   m.send_rpc(3001, json!({"type":"new_session"})).unwrap();
    //   // close stdin so cat exits, then read stdout
    //   drop(m.processes.lock().unwrap().get_mut(&3001).unwrap().stdin);  // or via kill
    //   let output = child.wait_with_output()?;
    //   assert_eq!(output.stdout, b"{\"type\":\"new_session\"}\n");
}

#[test]
fn send_rpc_returns_err_for_unknown_port() {
    let m = PiManager::new(PathBuf::from("/tmp"));
    let result = m.send_rpc(9999, serde_json::json!({"type":"ping"}));
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("9999"));
}
```

**Testability note:** accessing `stdin` after handing it to `PiProcess` is
awkward because `PiProcess.stdin` is consumed into the struct.  
The cleanest approach is the test-helper constructor again, which gives access
to a `ChildStdin`-backed pipe whose other end can be read in the test.

---

### Priority 3 — Path resolution (`resolve_bundled_pi`, `resolve_embedded_extension_path`)

These functions use `is_file()` / `exists()` and env-var overrides — fully
testable with `tempfile` + `std::env::set_var` (which is `unsafe` in Rust
1.80+; prefer `temp_env` crate in multithreaded tests).

---

#### T-9  `resolve_bundled_pi` — env-var override

```rust
#[test]
fn resolve_bundled_pi_uses_pi_bin_env_var() {
    let dir = TempDir::new().unwrap();
    let fake_pi = dir.path().join("pi");
    fs::write(&fake_pi, "#!/bin/sh").unwrap();
    // make executable on unix
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap(); }

    std::env::set_var("PI_BIN", fake_pi.to_str().unwrap());
    let m = PiManager::new(PathBuf::from("/tmp/nowhere"));
    let result = m.resolve_bundled_pi();
    std::env::remove_var("PI_BIN");

    assert_eq!(result.unwrap(), fake_pi);
}

#[test]
fn resolve_bundled_pi_env_var_ignored_when_file_missing() {
    std::env::set_var("PI_BIN", "/no/such/binary");
    let m = PiManager::new(PathBuf::from("/tmp/nowhere"));
    let result = m.resolve_bundled_pi();
    std::env::remove_var("PI_BIN");
    // Should fall through to Err, not return the nonexistent path.
    assert!(result.is_err());
}

#[test]
fn resolve_bundled_pi_finds_sibling_pi_dir() {
    // Layout: <static_dir>/../pi/pi  (the production bundle layout)
    let root = TempDir::new().unwrap();
    let static_dir = root.path().join("public");
    let pi_dir = root.path().join("pi");
    fs::create_dir_all(&static_dir).unwrap();
    fs::create_dir_all(&pi_dir).unwrap();
    let fake_pi = pi_dir.join("pi");
    fs::write(&fake_pi, "binary").unwrap();

    let m = PiManager::new(static_dir);
    assert_eq!(m.resolve_bundled_pi().unwrap(), fake_pi);
}

#[test]
fn resolve_bundled_pi_returns_err_with_tried_paths() {
    let m = PiManager::new(PathBuf::from("/tmp/no-such-static-dir"));
    let err = m.resolve_bundled_pi().unwrap_err();
    // Error message should mention the paths that were tried.
    assert!(err.contains("Tried"), "err = {}", err);
}
```

---

#### T-10  `resolve_embedded_extension_path` — env-var override + bundled candidate

```rust
#[test]
fn resolve_extension_uses_env_var_override() {
    let dir = TempDir::new().unwrap();
    let ext = dir.path().join("my-server.ts");
    fs::write(&ext, "export default {}").unwrap();
    std::env::set_var("PI_STUDIO_EXTENSION", ext.to_str().unwrap());
    let m = PiManager::new(PathBuf::from("/tmp/nowhere"));
    let res = m.resolve_embedded_extension_path().unwrap();
    std::env::remove_var("PI_STUDIO_EXTENSION");
    assert_eq!(res.source, "env:PI_STUDIO_EXTENSION");
}

#[test]
fn resolve_extension_finds_bundled_mjs() {
    // Layout: <static_dir>/../extensions/embedded-server.mjs
    let root = TempDir::new().unwrap();
    let static_dir = root.path().join("public");
    let ext_dir = root.path().join("extensions");
    fs::create_dir_all(&static_dir).unwrap();
    fs::create_dir_all(&ext_dir).unwrap();
    fs::write(ext_dir.join("embedded-server.mjs"), "export default {}").unwrap();

    let m = PiManager::new(static_dir);
    let res = m.resolve_embedded_extension_path().unwrap();
    assert_eq!(res.source, "bundled");
}

#[test]
fn resolve_extension_prefers_mjs_over_ts() {
    let root = TempDir::new().unwrap();
    let static_dir = root.path().join("public");
    let ext_dir = root.path().join("extensions");
    fs::create_dir_all(&static_dir).unwrap();
    fs::create_dir_all(&ext_dir).unwrap();
    fs::write(ext_dir.join("embedded-server.mjs"), "").unwrap();
    fs::write(ext_dir.join("embedded-server.ts"), "").unwrap();

    let m = PiManager::new(static_dir);
    let res = m.resolve_embedded_extension_path().unwrap();
    assert_eq!(res.source, "bundled"); // mjs wins over dev:source ts
}

#[test]
fn resolve_extension_returns_err_with_tried_candidates() {
    let m = PiManager::new(PathBuf::from("/tmp/no-such-static-dir"));
    let err = m.resolve_embedded_extension_path().unwrap_err();
    assert!(err.contains("Tried"), "err = {}", err);
}
```

---

### Priority 4 — `find_latest_session_boot_target` (integration-ish)

This function calls `dirs::home_dir()` directly, making it hard to unit test
without monkey-patching `HOME`. The recommended approach is to extract a
testable inner function:

```rust
// Suggested refactor
fn find_latest_in_root(sessions_root: &Path) -> Option<(String, String)> {
    // same body but accepts root as parameter
}

pub fn find_latest_session_boot_target() -> Option<(String, String)> {
    let root = dirs::home_dir()?.join(".pi/agent/sessions");
    find_latest_in_root(&root)
}
```

Then test `find_latest_in_root` directly:

```rust
#[test]
fn find_latest_picks_most_recently_modified() {
    let dir = TempDir::new().unwrap();
    let sub1 = dir.path().join("abc"); fs::create_dir_all(&sub1).unwrap();
    let sub2 = dir.path().join("def"); fs::create_dir_all(&sub2).unwrap();
    let older = sub1.join("old.jsonl");
    let newer = sub2.join("new.jsonl");

    // Write older first, then newer — mtime should differ enough
    fs::write(&older, r#"{"type":"session","cwd":"/old"}"#).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    fs::write(&newer, r#"{"type":"session","cwd":"/new"}"#).unwrap();

    let result = find_latest_in_root(dir.path()).unwrap();
    assert_eq!(result.0, "/new");
}

#[test]
fn find_latest_returns_none_for_missing_root() {
    assert!(find_latest_in_root(Path::new("/no/such/dir")).is_none());
}

#[test]
fn find_latest_returns_none_when_no_jsonl_has_cwd() {
    let dir = TempDir::new().unwrap();
    let sub = dir.path().join("s"); fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("x.jsonl"), r#"{"type":"message"}"#).unwrap();
    assert!(find_latest_in_root(dir.path()).is_none());
}
```

---

### Priority 5 — `wait_for_endpoint` timeout path (async integration)

```rust
#[tokio::test]
async fn wait_for_endpoint_times_out_when_port_not_open() {
    // Port 19999 is almost certainly not bound.
    let result = wait_for_endpoint(19999, "/api/health", 1).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Timed out"));
}

#[tokio::test]
async fn wait_for_endpoint_returns_ok_for_200_response() {
    // Spin up a tiny axum/hyper server on a random port.
    // Pseudocode:
    //   let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    //   let port = listener.local_addr().unwrap().port();
    //   tokio::spawn(serve_200_on(listener));
    //   wait_for_endpoint(port, "/", 5).await.unwrap();
}

#[tokio::test]
async fn wait_for_endpoint_retries_on_500() {
    // First request → 500, second request → 200.
    // Requires a mock HTTP server that can change response mid-test.
    // Pseudocode (wiremock or axum with shared AtomicBool):
    //   let served_500 = Arc::new(AtomicBool::new(false));
    //   let port = start_server_that_500s_once(served_500.clone());
    //   wait_for_endpoint(port, "/", 5).await.unwrap();
    //   assert!(served_500.load(Ordering::SeqCst));
}
```

---

## What Is Hard to Test and Why

| Item | Barrier | Mitigation |
|---|---|---|
| `PiManager::spawn` | Requires the embedded `pi` binary to be present and runnable | Integration test gated on `PI_BIN` env var; skip in CI without the binary |
| `wait_for_endpoint` | Needs a live HTTP listener | Use `tokio::net::TcpListener` + minimal `hyper`/`axum` handler inline in the test |
| `open_workspace_window` / `open_bootstrap_window` | Require a running `tauri::AppHandle` — cannot be constructed outside Tauri's runtime | No unit test path; covered only by manual smoke tests or Tauri's own integration test harness |
| `find_static_dir` | Takes `&tauri::App` | Same constraint as window helpers |
| `PiProcess` injection into map | `PiProcess` is private and wraps `Child`/`ChildStdin` | Add `#[cfg(test)] fn insert_dummy_for_test(&self, port: u16)` that spawns `sleep 9999` |
| `locked_pi_version` — non-nominal JSON | The string is a compile-time literal; can't feed alternate input to the public API without a refactor | Extract `parse_version_from(s: &str)` as a private helper and test it directly |
| `on_window_event` kill-on-destroy path | Embedded in the Tauri builder chain | Document as "covered by manual teardown test"; cannot unit test |

---

## Recommended Test Infrastructure Additions

1. **`tempfile` crate** — add to `[dev-dependencies]` in `Cargo.toml`:
   ```toml
   [dev-dependencies]
   tempfile = "3"
   temp_env = "0.3"   # thread-safe env-var scoping for T-9/T-10
   ```

2. **`#[cfg(test)] fn insert_dummy_for_test`** on `PiManager` —
   spawns `sleep 9999` (Unix) / `timeout /t 9999` (Windows), inserts
   the resulting `PiProcess` into `self.processes`. Unlocks T-6, T-7, T-8.

3. **Private `parse_version_from(s: &str) -> Option<String>`** helper
   extracted from `locked_pi_version` — unlocks T-2.

4. **`find_latest_in_root(root: &Path)`** inner function extracted from
   `find_latest_session_boot_target` — unlocks T-11/Priority-4 tests.

---

## Summary Table

| Test ID | Target | Value | Effort |
|---|---|---|---|
| T-1 | `locked_pi_version` nominal parse | 🔴 critical — production crash risk | tiny |
| T-3 | `extract_session_cwd` full case matrix | 🔴 high — drives session resume | small |
| T-4 | `list_session_files` walk + filtering | 🔴 high — drives session resume | small |
| T-2 | `locked_pi_version` alternate JSON forms | 🟡 medium — requires small refactor | small |
| T-9 | `resolve_bundled_pi` path resolution | 🟡 medium — silent wrong-binary risk | medium |
| T-10 | `resolve_embedded_extension_path` | 🟡 medium — silent no-API risk | medium |
| T-5 | `is_port_in_use` | 🟡 medium — foundation for T-6 | tiny |
| T-6 | `next_port` | 🟡 medium | requires T-dummy-helper |
| T-7 | `kill` / `kill_all` | 🟡 medium — process leak risk | requires T-dummy-helper |
| T-8 | `send_rpc` stdin write | 🟡 medium | requires T-dummy-helper |
| T-11 | `find_latest_session_boot_target` inner | 🟢 low-medium — requires refactor | medium |
| T-12 | `wait_for_endpoint` timeout + retry | 🟢 low — async infra overhead | high |
