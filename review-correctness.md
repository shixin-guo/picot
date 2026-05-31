# Correctness Review — `pi_manager.rs` / `main.rs`

Reviewed files: `src-tauri/src/pi_manager.rs`, `src-tauri/src/main.rs`  
Date: 2026-05-30

---

## Review

### Correct: what is already good

- `locked_pi_version` uses `OnceLock` correctly; the hand-rolled JSON extraction is safe for the fixed schema.
- `send_rpc` properly serializes and newline-terminates the JSON line before writing to stdin.
- `cmd_open_workspace` waits for health before opening the workspace window, avoiding the cold-start race for that path.
- `cmd_pick_folder` uses a oneshot channel correctly to bridge the callback-based dialog API into async Rust.
- `wait_for_endpoint` checks the deadline before each attempt and treats any non-5xx as success — appropriate for a health-poll loop.
- `find_static_dir` correctly prefers the bundled resource dir in release before falling back to compile-time `CARGO_MANIFEST_DIR` dev paths, avoiding the shadow-on-dev-machine bug.
- `extract_session_cwd` gracefully handles malformed JSONL lines via `serde_json::from_str` and `?`/`continue`.
- `kill_all` on `RunEvent::Exit` is correct; the OS reclaims zombie slots when the parent exits, so the lack of `wait()` there is not a practical problem.

---

## Blockers

### B1 — TOCTOU port-selection race → process leak / silent overwrite  
**File:** `pi_manager.rs`, `next_port()` (line ~323) and `spawn()` (line ~291)  
**File:** `main.rs`, `cmd_open_workspace()` (lines ~55–57)

`next_port()` acquires the mutex, reads the current port map and calls `is_port_in_use`, then **releases the lock before returning**. `spawn()` later reacquires the lock only at `lock.insert()` — after the slow `Command::spawn()` syscall. Two concurrent `cmd_open_workspace` invocations can therefore both call `next_port()` before either has inserted an entry, receive the **same port**, and both proceed to spawn:

```
Thread A: next_port() → 3002, lock released
Thread B: next_port() → 3002, lock released   (map still empty at 3002)
Thread A: Command::spawn(port=3002) → child_A
Thread B: Command::spawn(port=3002) → child_B
Thread A: lock.insert(3002, PiProcess{child_A})
Thread B: lock.insert(3002, PiProcess{child_B}) ← silently overwrites child_A
```

`child_A` is now dropped without `kill()` and becomes an unkillable zombie (its port is already bound; `child_B`'s `bind()` will fail). The manager's map holds `child_B` as if it successfully owns port 3002, but `wait_for_health` may now race against whichever child actually bound the port.

**Fix:** Hold the mutex across the entire `next_port` → `insert` sequence. Move the port selection into `spawn()` itself so that selection and insertion are atomic under one lock acquisition, e.g.:

```rust
pub fn spawn(&self, cwd: &str, session_path: Option<&str>) -> Result<(u16, ()), String> {
    let pi_bin = self.resolve_bundled_pi()?;
    let extension = self.resolve_embedded_extension_path()?;
    // … build args …
    let mut child = Command::new(&pi_bin)…spawn()?;
    let stdin = child.stdin.take()…;

    let mut lock = self.processes.lock().unwrap();
    let port = {
        let mut p = 3001u16;
        while lock.contains_key(&p) || is_port_in_use(p) { p += 1; }
        p
    };
    lock.insert(port, PiProcess { child, stdin });
    Ok((port, ()))
}
```

This removes the public `next_port()` method and makes port allocation + process registration atomic. Callers that previously called `next_port()` first now just call `spawn()` and receive the allocated port back.

---

### B2 — `#` and `%` in error messages corrupt the bootstrap query string  
**File:** `main.rs`, `open_bootstrap_window()` (lines ~166–170)

```rust
let encoded_error = startup_error
    .replace('&', "%26")
    .replace(' ', "%20")
    .replace('\n', "%0A");
let url = format!("bootstrap.html?startupError={}", encoded_error);
```

Only three characters are encoded. Error messages from `resolve_bundled_pi` and `resolve_embedded_extension_path` contain **file paths**, which can include `#`, `%`, `=`, `?`, and path separators. Two characters cause incorrect runtime behaviour:

- **`#`** — The browser treats everything after the first `#` in a URL as the fragment identifier, not part of the query string. Any `#` in the error string silently truncates `startupError` as seen by `bootstrap.html`'s query parser.
- **`%`** — A literal `%` that is not followed by two hex digits produces an invalid percent-encoding sequence. `decodeURIComponent` (commonly used in JS query parsers) throws `URIError: URI malformed`, crashing the bootstrap page's JS entirely and showing a blank error dialog instead of the actual error.

Concrete realistic trigger: path `/Users/foo/work-100%/src` produces `%/src` in the query value, which makes `decodeURIComponent` throw.

**Fix:** Use proper percent-encoding. The `percent-encoding` crate (or a minimal hand-roll encoding all bytes except unreserved chars A–Z a–z 0–9 `-._~`) is correct. Minimum viable fix — encode every byte outside `[A-Za-z0-9\-._~]`:

```rust
fn percent_encode(s: &str) -> String {
    s.bytes().flat_map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
        | b'-' | b'_' | b'.' | b'~' => vec![b as char],
        _ => format!("%{:02X}", b).chars().collect(),
    }).collect()
}
```

---

## Notes

### N1 — Zombie processes accumulate on Unix across workspace open/close cycles  
**File:** `pi_manager.rs`, `kill()` (line ~309) and `kill_all()` (line ~316)

```rust
pub fn kill(&self, port: u16) {
    let mut lock = self.processes.lock().unwrap();
    if let Some(mut proc) = lock.remove(&port) {
        let _ = proc.child.kill();
        // child is dropped here — NO wait()
    }
}
```

On Unix, calling `kill()` on a child process sends SIGKILL but does not reap the child. The child remains in the process table as a zombie until the parent calls `waitpid()`. Rust's `Child::drop` does **not** call `wait()` — from the stdlib docs: "Dropping a `Child` does not wait for it to exit." Each closed workspace window therefore leaves one zombie in the process table. For a typical session of opening and closing a handful of workspaces this is negligible; for long-running usage or automated testing it accumulates.

`kill_all()` on `RunEvent::Exit` is acceptable because the OS reclaims all zombies when the parent process exits. The issue is with `kill()` called from `on_window_event::Destroyed` during the app's lifetime.

**Fix:** After `proc.child.kill()`, call `let _ = proc.child.wait();`. `kill()` first, then `wait()` — the SIGKILL guarantees the wait returns promptly.

```rust
if let Some(mut proc) = lock.remove(&port) {
    let _ = proc.child.kill();
    let _ = proc.child.wait();  // reap immediately; can't block after SIGKILL
}
```

---

### N2 — `setup()` opens the workspace window before pi is listening  
**File:** `main.rs`, `main()` → `setup()` closure (lines ~383–412)

In `setup()`:
```rust
manager.spawn(&cwd, initial_port, …)?;          // spawn only
open_workspace_window(&app.handle(), initial_port)?; // window opens NOW
tauri::async_runtime::spawn(async move {
    wait_for_health(initial_port, 30).await       // health check in background
});
```

The WebView opens and immediately loads `http://localhost:<port>`. Pi has not finished starting yet, so the initial HTTP request returns a connection-refused error. The WebView shows a browser error page. The background health-check task has no mechanism to reload the window once pi is ready (only logs to stderr).

`cmd_open_workspace`, by contrast, correctly awaits `wait_for_health` before calling `open_workspace_window`. The two startup paths are inconsistent.

**Fix:** Either await health in `setup()` (blocking setup's synchronous context is problematic with Tauri), or use `tauri::async_runtime::spawn` for the entire spawn+wait+open sequence, leaving `setup()` itself non-blocking. A simpler workaround is to have `bootstrap.html` / the initial page JS poll for readiness and redirect itself — but the Rust-side inconsistency should still be noted. The cleanest fix:

```rust
let handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    if wait_for_health(initial_port, 30).await.is_ok() {
        let _ = open_workspace_window(&handle, initial_port);
    } else {
        eprintln!("[pi-desktop] pi failed to start on port {}", initial_port);
    }
});
```

---

### N3 — `send_rpc` holds the Mutex during a blocking pipe write  
**File:** `pi_manager.rs`, `send_rpc()` (lines ~297–307)

```rust
pub fn send_rpc(&self, port: u16, cmd: serde_json::Value) -> Result<(), String> {
    let mut lock = self.processes.lock().unwrap();
    let proc = lock.get_mut(&port)…;
    proc.stdin.write_all(line.as_bytes())…   // blocking I/O while lock held
}
```

If the pi process stops draining its stdin (e.g., stuck in a long computation or deadlocked internally), the stdin pipe buffer fills (~64 KB on Linux). The next `write_all` blocks indefinitely **while holding the Mutex**. Any concurrent call to `kill(port)` also needs the Mutex and will block forever — making it impossible to kill the stuck pi process from Rust. `cmd_stop_instance` from the frontend would hang.

In practice, pi in `--mode rpc` reads stdin continuously, so the buffer is unlikely to fill. A pi crash causes `BrokenPipe` which `write_all` returns promptly. The scenario requires pi to be alive but not reading — unusual but not impossible (e.g., the event loop is blocked in a synchronous user-extension call).

**Fix:** Release the lock before the write by cloning the `ChildStdin` out is not possible (it's not `Clone`). Instead, store the `ChildStdin` separately from the `Child` behind its own `Mutex<Option<ChildStdin>>`, so the write lock is independent of the kill lock. Or, accept the current risk given the low likelihood and add a `set_write_timeout` / non-blocking write with `O_NONBLOCK` on the pipe fd. At minimum, document the assumption.
