use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct PiProcess {
    child: Child,
    stdin: ChildStdin,
}

pub struct PiManager {
    processes: Arc<Mutex<HashMap<u16, PiProcess>>>,
    static_dir: PathBuf,
}

struct EmbeddedExtensionResolution {
    path: String,
    /// Tag describing which candidate matched, for diagnostic logging.
    /// Examples: "bundled", "dev:source", "env:PI_STUDIO_EXTENSION".
    source: &'static str,
}

/// `scripts/pi-version.json` baked into the binary at compile time so we can
/// forward the locked pi version to the embedded server (which displays it
/// in the UI footer) without re-running fetch logic at startup.
const PI_VERSION_JSON: &str = include_str!("../../scripts/pi-version.json");

/// Locked pi version string (e.g. "0.77.0"). Resolved lazily on first call.
pub fn locked_pi_version() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(|| {
        // We deliberately do a hand-rolled extraction rather than a full
        // serde_json parse: this string is baked in at compile time, the
        // schema is trivial ({"version": "..."}), and avoiding the
        // dependency makes this fn callable from `const` contexts in the
        // future if needed. If the JSON shape grows, switch to serde_json.
        let needle = "\"version\"";
        let bytes = PI_VERSION_JSON;
        let start = bytes
            .find(needle)
            .expect("pi-version.json: missing \"version\" key");
        let after_key = &bytes[start + needle.len()..];
        let colon = after_key
            .find(':')
            .expect("pi-version.json: malformed \"version\" entry");
        let after_colon = &after_key[colon + 1..];
        let first_quote = after_colon
            .find('"')
            .expect("pi-version.json: \"version\" value not quoted");
        let rest = &after_colon[first_quote + 1..];
        let end_quote = rest
            .find('"')
            .expect("pi-version.json: unterminated \"version\" value");
        rest[..end_quote].to_string()
    })
}

impl PiManager {
    pub fn new(static_dir: PathBuf) -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            static_dir,
        }
    }

    /// Locate the embedded pi binary shipped inside the Tauri bundle.
    ///
    /// Lookup order:
    /// 1. `PI_BIN` env var (escape hatch for testing a different binary).
    /// 2. `<static_dir>/../pi/<bin>` — the production location, sibling of
    ///    the bundled `public/` and `extensions/` resource dirs.
    /// 3. *Debug builds only:* `<repo>/src-tauri/resources/pi/<bin>` —
    ///    populated by `bun run fetch:pi`, used during `tauri dev`.
    ///
    /// Returns `Err` (not `Ok(None)`) if no binary is found, so callers can
    /// surface a clear "run `bun run fetch:pi`" message rather than spawning
    /// a missing/stale binary.
    fn resolve_bundled_pi(&self) -> Result<PathBuf, String> {
        let bin_name = if cfg!(target_os = "windows") {
            "pi.exe"
        } else {
            "pi"
        };

        // Explicit override (rare; useful when smoke-testing a hand-built pi).
        if let Ok(explicit) = std::env::var("PI_BIN") {
            let candidate = PathBuf::from(explicit.trim());
            if candidate.is_file() {
                return Ok(candidate);
            }
        }

        let mut tried: Vec<PathBuf> = Vec::new();
        let bundled = self
            .static_dir
            .parent()
            .map(|parent| parent.join("pi").join(bin_name));
        if let Some(p) = bundled.clone() {
            if p.is_file() {
                return Ok(p);
            }
            tried.push(p);
        }

        if cfg!(debug_assertions) {
            let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("pi")
                .join(bin_name);
            if dev_path.is_file() {
                return Ok(dev_path);
            }
            tried.push(dev_path);
        }

        let tried_str = tried
            .iter()
            .map(|p| format!("  - {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "Could not find embedded pi binary. Tried:\n{}\n\n\
             For dev: run `bun run fetch:pi` from the repo root.\n\
             For release: the .app bundle is missing `resources/pi/{}`. \
             Reinstall Pi Studio.",
            tried_str, bin_name
        ))
    }

    /// Locate the embedded-server extension shipped with this build.
    ///
    /// Returns the first existing candidate from this priority order:
    ///
    /// 1. `PI_STUDIO_EXTENSION` env var (explicit override; useful for tests).
    /// 2. Bundled `extensions/embedded-server.mjs` next to `static_dir`. This
    ///    is what shipped Pi Studio installs use; the bundle is produced by
    ///    `scripts/build-extensions.js` and is fully self-contained (no
    ///    `node_modules` lookup at runtime).
    /// 3. Source `extensions/embedded-server.ts` next to `static_dir`. Used
    ///    by `tauri dev` where pi loads the raw `.ts` via jiti against the
    ///    repo's `node_modules/`.
    /// 4. *Debug builds only:* repo-relative paths via `CARGO_MANIFEST_DIR`
    ///    and `cwd`. These are gated to debug builds because
    ///    `CARGO_MANIFEST_DIR` is a compile-time string and would otherwise
    ///    silently "work" only on the build machine.
    ///
    /// Returns `Err` (not `Ok(None)`) when nothing is found, so callers can
    /// fail-fast and surface the error to the user instead of silently
    /// spawning a pi that has no `/api` surface.
    fn resolve_embedded_extension_path(&self) -> Result<EmbeddedExtensionResolution, String> {
        if let Ok(explicit) = std::env::var("PI_STUDIO_EXTENSION") {
            let candidate = explicit.trim();
            if !candidate.is_empty() && Path::new(candidate).exists() {
                return Ok(EmbeddedExtensionResolution {
                    path: candidate.to_string(),
                    source: "env:PI_STUDIO_EXTENSION",
                });
            }
        }

        let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
        if let Some(parent) = self.static_dir.parent() {
            candidates.push((
                parent.join("extensions").join("embedded-server.mjs"),
                "bundled",
            ));
            candidates.push((
                parent.join("extensions").join("embedded-server.ts"),
                "dev:source",
            ));
        }

        // Compile-time path fallbacks: only useful while developing locally.
        // Release builds must rely on the bundled .mjs; if that is missing we
        // want a loud error, not a silent fallback to the build machine's
        // hard-coded path (the previous behaviour, which made the same .app
        // "work" on the developer's machine and fail everywhere else).
        if cfg!(debug_assertions) {
            candidates.push((
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("embedded-server.ts"),
                "dev:cargo-manifest-dir",
            ));
            if let Ok(cwd) = std::env::current_dir() {
                candidates.push((cwd.join("extensions").join("embedded-server.ts"), "dev:cwd"));
            }
        }

        for (candidate, source) in &candidates {
            if candidate.exists() {
                return Ok(EmbeddedExtensionResolution {
                    path: candidate.to_string_lossy().to_string(),
                    source,
                });
            }
        }

        let tried = candidates
            .into_iter()
            .map(|(p, source)| format!("  - [{}] {}", source, p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "Could not find embedded-server extension. Tried:\n{}\n\n\
             For release builds, this means the .app bundle is missing \
             `extensions/embedded-server.mjs` (run `bun run build:extensions` \
             before `tauri build`). For dev, make sure `extensions/embedded-server.ts` \
             exists in this repo.",
            tried
        ))
    }

    pub fn spawn(&self, cwd: &str, port: u16, session_path: Option<&str>) -> Result<(), String> {
        let pi_bin = self.resolve_bundled_pi()?;
        let static_dir = self.static_dir.to_string_lossy().to_string();

        // We treat a missing embedded-server extension as a hard error
        // rather than continuing to spawn pi without `--extension`. Without
        // the extension, pi runs as a plain RPC process with no
        // `/api/sessions` or `/ws`, which the web UI then renders as
        // "Failed to load sessions" / "Disconnected" — a confusing soft
        // failure that hides the real bundling bug.
        let extension = self.resolve_embedded_extension_path()?;
        eprintln!(
            "[pi-desktop] embedded-server resolved: source={} path={}",
            extension.source, extension.path
        );

        let mut args: Vec<String> = vec![
            "--extension".to_string(),
            extension.path,
            "--mode".to_string(),
            "rpc".to_string(),
        ];
        if let Some(session) = session_path {
            args.push("--session".to_string());
            args.push(session.to_string());
        }

        eprintln!(
            "[pi-desktop] spawning pi: bin={} args={:?} cwd={} port={} static_dir={}",
            pi_bin.display(),
            args,
            cwd,
            port,
            static_dir
        );

        let mut child = Command::new(&pi_bin);
        child
            .args(&args)
            .current_dir(cwd)
            .env("PI_STUDIO_STATIC_DIR", &static_dir)
            .env("PI_STUDIO_PORT", port.to_string())
            .env("PI_STUDIO_PI_VERSION", locked_pi_version())
            .stdin(Stdio::piped())
            // Drop stdout: pi emits RPC frames on it that we don't consume here, and
            // letting it fill an unread pipe would eventually block the child.
            .stdout(Stdio::null())
            // Inherit stderr so pi's startup/runtime errors are visible in the same
            // terminal running `bun run dev` — critical for diagnosing failures of
            // new_session / open_workspace that would otherwise be silent.
            .stderr(Stdio::inherit());

        let spawn_started_at = Instant::now();
        let mut child = child.spawn().map_err(|e| {
            format!(
                "Failed to spawn embedded pi ({}): {}. \
                 The bundled binary may be corrupted or unsupported on this OS/arch. \
                 Reinstall Pi Studio, or for dev rerun `bun run fetch:pi`.",
                pi_bin.display(),
                e,
            )
        })?;
        eprintln!(
            "[pi-desktop] pi process spawned: port={} pid={} elapsed_ms={}",
            port,
            child.id(),
            spawn_started_at.elapsed().as_millis()
        );
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get pi stdin".to_string())?;

        let mut lock = self.processes.lock().unwrap();
        lock.insert(port, PiProcess { child, stdin });

        Ok(())
    }

    /// Send an RPC command to a pi instance (JSON line on stdin)
    pub fn send_rpc(&self, port: u16, cmd: serde_json::Value) -> Result<(), String> {
        let mut lock = self.processes.lock().unwrap();
        let proc = lock
            .get_mut(&port)
            .ok_or_else(|| format!("No pi instance on port {}", port))?;
        let mut line = cmd.to_string();
        line.push('\n');
        proc.stdin
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, port: u16) {
        let mut lock = self.processes.lock().unwrap();
        if let Some(mut proc) = lock.remove(&port) {
            let _ = proc.child.kill();
        }
    }

    pub fn kill_all(&self) {
        let mut lock = self.processes.lock().unwrap();
        for (_, mut proc) in lock.drain() {
            let _ = proc.child.kill();
        }
    }

    pub fn next_port(&self) -> u16 {
        let lock = self.processes.lock().unwrap();
        let mut port = 3001u16;
        while lock.contains_key(&port) || is_port_in_use(port) {
            port += 1;
        }
        port
    }
}

pub fn is_port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_err()
}

pub async fn wait_for_health(port: u16, timeout_secs: u64) -> Result<(), String> {
    wait_for_endpoint(port, "/api/health", timeout_secs).await
}

/// Wait for a specific HTTP endpoint on the pi instance to respond with a non-5xx status.
/// Useful when we need to confirm the API surface the frontend will hit first (e.g. /api/sessions)
/// is ready before navigating, avoiding cold-start races where /api/health is up but route
/// handlers are still warming.
pub async fn wait_for_endpoint(port: u16, path: &str, timeout_secs: u64) -> Result<(), String> {
    let url = format!("http://localhost:{}{}", port, path);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!("Timed out waiting for {} on port {}", path, port));
        }
        if let Ok(resp) = reqwest::get(&url).await {
            if resp.status().as_u16() < 500 {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
