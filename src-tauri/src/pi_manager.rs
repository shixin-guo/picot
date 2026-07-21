// ABOUTME: Owns embedded Pi child processes, ports, identities, and RPC pipes.
// ABOUTME: Provides safe spawn, routing, exit observation, and exact cleanup.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

use rand::rngs::OsRng;
use rand::RngCore;
use tokio::sync::broadcast;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const QUICK_CHAT_TEMP_PREFIX: &str = "picot-quick-chat-";
const QUICK_CHAT_TOKEN_BYTES: usize = 16;

/// Generalized spawn request. The host owns every field; callers never inject
/// capability, owner tokens, executables, or arbitrary flags through this.
#[derive(Clone, Debug)]
pub struct PiSpawnSpec {
    pub cwd: PathBuf,
    pub port: u16,
    pub session_path: Option<String>,
    pub no_session: bool,
    pub no_tools: bool,
    pub environment: Vec<(String, String)>,
}

/// Identity of a just-spawned pi process, returned to the host for tracking.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpawnedPi {
    pub port: u16,
    pub pid: u32,
    pub identity: u64,
}

/// Natural-exit notification for one exact (port, pid) pi process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessExit {
    pub port: u16,
    pub pid: u32,
    pub identity: u64,
}

/// One JSON frame emitted by Pi's RPC stdout, such as an extension UI request.
#[derive(Clone, Debug)]
pub struct RpcOutput {
    pub port: u16,
    pub payload: serde_json::Value,
}

struct PiProcess {
    child: Child,
    stdin: ChildStdin,
    pid: u32,
    identity: u64,
}

pub struct PiManager {
    processes: Arc<Mutex<HashMap<u16, PiProcess>>>,
    /// Maps session_file -> port for dedicated per-session processes.
    session_ports: Arc<Mutex<HashMap<String, u16>>>,
    /// Maps workspace_port -> [dedicated session ports] for cleanup on window close.
    workspace_dedicated: Arc<Mutex<HashMap<u16, Vec<u16>>>>,
    static_dir: PathBuf,
    exit_sender: broadcast::Sender<ProcessExit>,
    rpc_output_sender: broadcast::Sender<RpcOutput>,
    next_process_identity: AtomicU64,
    /// Cached result of `get_available_models` from the first Pi instance that
    /// responded. Shared across all windows/chats so Side/Quick Chat and new
    /// sessions populate their dropdowns instantly without re-querying Pi.
    /// Invalidated when API keys or package extensions change.
    model_cache: Arc<Mutex<Option<CachedModels>>>,
    /// Pre-spawned pi processes waiting to be adopted by a Side Chat or
    /// Quick Chat request. Keyed by (cwd, no_tools) so a Side Chat standby
    /// (workspace cwd, tools enabled) is never handed to a Quick Chat
    /// (temp cwd, no tools) and vice versa.
    standby_pool: Arc<Mutex<Vec<StandbyEntry>>>,
    /// Ports reserved between allocation and child registration so concurrent
    /// spawns cannot claim the same listener.
    reserved_ports: Arc<Mutex<HashSet<u16>>>,
    /// One active warm-up per standby key. A canceled lease may not park its
    /// child, so a workspace transition cannot resurrect an old standby.
    standby_warming: Arc<Mutex<HashMap<StandbyWarmKey, u64>>>,
    next_standby_warm: AtomicU64,
}

/// Snapshot of `get_available_models` output, captured once per Pi process
/// lifetime and shared across all Picot windows/chats.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct CachedModels {
    pub source_port: u16,
    pub payload: serde_json::Value,
    pub cached_at: std::time::Instant,
}

/// A pre-spawned pi process held in the standby pool, waiting to be adopted
/// by a Side Chat or Quick Chat request. The cwd and no_tools flags are the
/// match key: a Side Chat standby (workspace cwd, tools enabled) cannot serve
/// a Quick Chat (temp cwd, no tools) and vice versa, because cwd is fixed at
/// spawn time and tools are baked into the process.
#[derive(Clone, Debug)]
struct StandbyEntry {
    cwd: PathBuf,
    no_tools: bool,
    spawned: SpawnedPi,
    /// Quick Chat standbys carry their pre-created temp directory so the
    /// caller can record it for later cleanup. Side Chat standbys set None.
    temp_dir: Option<(PathBuf, String)>,
    created_at: std::time::Instant,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct StandbyWarmKey {
    cwd: Option<PathBuf>,
    no_tools: bool,
}

/// A single in-flight standby warm-up. The generation prevents a canceled
/// worker from parking a child after another warm-up has replaced it.
#[derive(Clone, Debug)]
pub struct StandbyWarmLease {
    key: StandbyWarmKey,
    generation: u64,
}

fn standby_matches(entry: &StandbyEntry, cwd: &Path, no_tools: bool) -> bool {
    if no_tools {
        entry.no_tools
    } else {
        !entry.no_tools && entry.cwd == cwd
    }
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

#[cfg(target_os = "windows")]
fn configure_child_process_for_windows(command: &mut Command) {
    // Prevent child `pi.exe` processes from creating a visible console window
    // when Picot runs as a GUI app on Windows.
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_process_for_windows(_command: &mut Command) {}

/// Build an augmented PATH for child processes.
///
/// `fix_path_env::fix()` is called at app startup and already merges the
/// user's login-shell PATH into this process.  This function is a second
/// safety net: it appends any well-known tool directories that might still
/// be absent (e.g. nvm-managed node versions, Volta, Bun, Mise shims) so
/// that `npm`, `npx`, and friends are always reachable.
///
/// Directories already present in PATH are not duplicated.
fn build_augmented_path() -> String {
    use std::path::{Path, PathBuf};

    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();

    #[cfg(not(target_os = "windows"))]
    {
        let mut extras: Vec<PathBuf> = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];

        if let Ok(home) = std::env::var("HOME") {
            let h = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(h));
            extras.push(h.join(".local/bin"));
            extras.push(h.join(".bun/bin"));
            extras.push(h.join(".volta/bin"));
            extras.push(h.join(".cargo/bin"));
            extras.push(h.join(".local/share/mise/shims"));
            // nvm: enumerate all installed node versions
            let nvm_root = h.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(nvm_root) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extras.push(bin);
                    }
                }
            }
        }

        for extra in extras {
            if !dirs.iter().any(|d| d == &extra) {
                dirs.push(extra);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut extras: Vec<PathBuf> = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(Path::new(&appdata).join("npm"));
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            let h = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(h));
            extras.push(h.join(".cargo").join("bin"));
            extras.push(h.join(".bun").join("bin"));
            extras.push(h.join("scoop").join("shims"));
        }
        for extra in extras {
            if !dirs.iter().any(|d| d == &extra) {
                dirs.push(extra);
            }
        }
    }

    std::env::join_paths(dirs)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

fn pi_extension_npm_bin_dir(home: &Path) -> PathBuf {
    home.join(".pi")
        .join("agent")
        .join("npm")
        .join("node_modules")
        .join(".bin")
}

fn log_child_path_diagnostics(context: &str, path: &str) {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let Some(home) = home else {
        log::info!(
            "[pi-desktop] child PATH diagnostics: context={} home=<unset> path={}",
            context,
            path
        );
        return;
    };

    let pi_extension_bin = pi_extension_npm_bin_dir(Path::new(&home));
    let hypa_bin = pi_extension_bin.join(if cfg!(target_os = "windows") {
        "hypa.cmd"
    } else {
        "hypa"
    });
    let dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
    let contains_pi_extension_bin = dirs.iter().any(|dir| dir == &pi_extension_bin);

    log::info!(
        "[pi-desktop] child PATH diagnostics: context={} pi_extension_bin={} exists={} hypa_bin={} hypa_exists={} contains_pi_extension_bin={} path={}",
        context,
        pi_extension_bin.display(),
        pi_extension_bin.is_dir(),
        hypa_bin.display(),
        hypa_bin.is_file(),
        contains_pi_extension_bin,
        path
    );
}

/// Strip a Windows verbatim / extended-length path prefix (`\\?\` or
/// `\\?\UNC\`) from a path string.
///
/// Tauri's `resource_dir()` returns extended-length paths (e.g.
/// `\\?\C:\Users\...\Picot\pi\pi.exe`). The embedded pi (Bun 1.3.10,
/// Windows arm64, compiled standalone) segfaults (`Segmentation fault at
/// address 0x18`) when it is launched with — or asked to load an
/// `--extension` from — a `\\?\`-prefixed path. Passing the plain
/// `C:\Users\...` form avoids the crash. This is a no-op on non-Windows
/// platforms and for paths without the prefix.
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // `\\?\UNC\server\share` -> `\\server\share`
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Return a path to the embedded-server extension that is safe to pass as a
/// `--extension` argument to the embedded pi binary.
///
/// On Windows the Bun-compiled pi binary truncates `--extension` values at the
/// first space (e.g. `C:\...\Picot\...\embedded-server.mjs` is loaded as
/// `C:\...\Pi`), which then fails to load and segfaults the process. Since Pi
/// Studio always installs under a space-containing path, we mirror the
/// extension file into a space-free directory under the system temp dir and
/// return that path instead. The copy is idempotent (skipped when an existing
/// mirror already matches by length + mtime), so repeated spawns are cheap.
///
/// On non-Windows platforms, or when the path has no space, the original path
/// is returned unchanged.
#[cfg(not(target_os = "windows"))]
fn sanitize_extension_path_for_pi(original: &str) -> String {
    original.to_string()
}

#[cfg(target_os = "windows")]
fn sanitize_extension_path_for_pi(original: &str) -> String {
    if !original.contains(' ') {
        return original.to_string();
    }

    match mirror_to_space_free_dir(Path::new(original)) {
        Ok(mirrored) => {
            log::info!(
                "[pi-desktop] extension path contains spaces; mirrored to space-free path: {} -> {}",
                original,
                mirrored.display()
            );
            mirrored.to_string_lossy().to_string()
        }
        Err(e) => {
            // Non-fatal: fall back to the original path. Worst case is the
            // pre-existing crash, but we don't want the mirroring step itself
            // to be a new hard failure mode.
            log::warn!(
                "[pi-desktop] failed to mirror extension to space-free path ({}); using original: {}",
                e,
                original
            );
            original.to_string()
        }
    }
}

/// Copy `src` into `<temp>/pi-studio-ext/<filename>` (a space-free directory),
/// skipping the copy when an up-to-date mirror already exists. Returns the
/// mirrored path.
#[cfg(target_os = "windows")]
fn mirror_to_space_free_dir(src: &Path) -> std::io::Result<PathBuf> {
    let file_name = src.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "extension path has no file name",
        )
    })?;

    let mut dest_dir = std::env::temp_dir();
    // Guard: if the temp dir itself contains a space, fall back to a
    // well-known space-free root so the workaround actually helps.
    if dest_dir.to_string_lossy().contains(' ') {
        dest_dir = PathBuf::from("C:\\ProgramData\\pi-studio");
    }
    dest_dir.push("pi-studio-ext");
    std::fs::create_dir_all(&dest_dir)?;

    let dest = dest_dir.join(file_name);

    if mirror_is_up_to_date(src, &dest) {
        return Ok(dest);
    }

    std::fs::copy(src, &dest)?;
    Ok(dest)
}

/// Cheap freshness check: the mirror is considered current when it exists and
/// matches the source by byte length and modified time. This avoids re-copying
/// the extension on every spawn while still picking up updated builds.
#[cfg(target_os = "windows")]
fn mirror_is_up_to_date(src: &Path, dest: &Path) -> bool {
    let (Ok(src_meta), Ok(dest_meta)) = (std::fs::metadata(src), std::fs::metadata(dest)) else {
        return false;
    };
    if src_meta.len() != dest_meta.len() {
        return false;
    }
    match (src_meta.modified(), dest_meta.modified()) {
        (Ok(src_mtime), Ok(dest_mtime)) => dest_mtime >= src_mtime,
        _ => false,
    }
}
impl PiManager {
    pub fn new(static_dir: PathBuf) -> Self {
        let (exit_sender, _) = broadcast::channel(64);
        let (rpc_output_sender, _) = broadcast::channel(128);
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            session_ports: Arc::new(Mutex::new(HashMap::new())),
            workspace_dedicated: Arc::new(Mutex::new(HashMap::new())),
            static_dir,
            exit_sender,
            rpc_output_sender,
            next_process_identity: AtomicU64::new(1),
            model_cache: Arc::new(Mutex::new(None)),
            standby_pool: Arc::new(Mutex::new(Vec::new())),
            reserved_ports: Arc::new(Mutex::new(HashSet::new())),
            standby_warming: Arc::new(Mutex::new(HashMap::new())),
            next_standby_warm: AtomicU64::new(1),
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
             Reinstall Picot.",
            tried_str, bin_name
        ))
    }

    /// Locate the embedded-server extension shipped with this build.
    ///
    /// Returns the first existing candidate from this priority order:
    ///
    /// 1. `PI_STUDIO_EXTENSION` env var (explicit override; useful for tests).
    /// 2. Bundled `extensions/embedded-server.mjs` next to `static_dir`. This
    ///    is what shipped Picot installs use; the bundle is produced by
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

        // Compile-time path fallbacks: only useful while developing locally.
        // Prefer the live source in debug builds before any target/debug bundle:
        // that bundle can be stale after frontend/extension edits and causes the
        // dev app to serve old API behavior until a full resource copy happens.
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

    pub fn spawn_with_spec(&self, spec: &PiSpawnSpec) -> Result<SpawnedPi, String> {
        let result = self.spawn_with_spec_inner(spec);
        self.reserved_ports.lock().unwrap().remove(&spec.port);
        result
    }

    fn spawn_with_spec_inner(&self, spec: &PiSpawnSpec) -> Result<SpawnedPi, String> {
        let pi_bin = self.resolve_bundled_pi()?;
        // Tauri resolves resource paths as `\\?\`-prefixed extended-length
        // paths. Bun (the embedded pi runtime) segfaults on Windows arm64 when
        // launched from such a path, so normalize the binary path and every
        // path-shaped argument/env we hand to it back to the plain form.
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let static_dir = strip_verbatim_prefix(&self.static_dir.to_string_lossy());
        let cwd = strip_verbatim_prefix(&spec.cwd.to_string_lossy());

        // A missing embedded-server extension is a hard error: without it pi
        // runs as a plain RPC process with no `/api` or `/ws`, which surfaces
        // as a confusing "Failed to load sessions" soft failure.
        let extension = self.resolve_embedded_extension_path()?;
        log::info!(
            "[pi-desktop] embedded-server resolved: source={} path={}",
            extension.source,
            extension.path
        );
        let extension_path =
            sanitize_extension_path_for_pi(&strip_verbatim_prefix(&extension.path));

        let args = build_pi_args(&extension_path, spec)?;
        log::info!(
            "[pi-desktop] spawning pi: bin={} args={:?} cwd={} port={} static_dir={}",
            pi_bin_str,
            args,
            cwd,
            spec.port,
            static_dir
        );

        let augmented_path = build_augmented_path();
        log_child_path_diagnostics("spawn", &augmented_path);

        let mut child = Command::new(&pi_bin_str);
        configure_child_process_for_windows(&mut child);
        child
            .args(&args)
            .current_dir(&cwd)
            .env("PATH", augmented_path)
            .env("PI_STUDIO_STATIC_DIR", &static_dir)
            .env("PI_STUDIO_PORT", spec.port.to_string())
            .env("PI_STUDIO_PI_VERSION", locked_pi_version());
        // Ephemeral markers (kind, instance id, generation) are the only extra
        // environment the host may inject; they never include a capability or
        // owner token.
        for (key, value) in &spec.environment {
            child.env(key, value);
        }
        child
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherit stderr so pi's startup/runtime errors are visible in the same
            // terminal running `bun run dev` — critical for diagnosing failures of
            // new_session / open_workspace that would otherwise be silent.
            .stderr(Stdio::inherit());

        let spawn_started_at = Instant::now();
        let mut child = child.spawn().map_err(|e| {
            format!(
                "Failed to spawn embedded pi ({}): {}. \
                 The bundled binary may be corrupted or unsupported on this OS/arch. \
                 Reinstall Picot, or for dev rerun `bun run fetch:pi`.",
                pi_bin.display(),
                e,
            )
        })?;
        let pid = child.id();
        let identity = self.next_process_identity.fetch_add(1, Ordering::Relaxed);
        log::info!(
            "[pi-desktop] pi process spawned: port={} pid={} identity={} elapsed_ms={}",
            spec.port,
            pid,
            identity,
            spawn_started_at.elapsed().as_millis()
        );
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get pi stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to get pi stdout".to_string())?;

        let output_sender = self.rpc_output_sender.clone();
        let output_port = spec.port;
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(payload) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let _ = output_sender.send(RpcOutput {
                    port: output_port,
                    payload,
                });
            }
        });

        {
            let mut lock = self.processes.lock().unwrap();
            lock.insert(
                spec.port,
                PiProcess {
                    child,
                    stdin,
                    pid,
                    identity,
                },
            );
        }
        self.watch_process_exit(spec.port, pid, identity);
        Ok(SpawnedPi {
            port: spec.port,
            pid,
            identity,
        })
    }

    /// Existing workspace spawn behavior expressed through the generalized spec.
    pub fn spawn(&self, cwd: &str, port: u16, session_path: Option<&str>) -> Result<(), String> {
        let spec = PiSpawnSpec {
            cwd: PathBuf::from(cwd),
            port,
            session_path: session_path.map(|s| s.to_string()),
            no_session: false,
            no_tools: false,
            environment: vec![],
        };
        self.spawn_with_spec(&spec).map(|_| ())
    }

    /// Poll one exact (port, pid) child for natural exit, emitting a single
    /// ProcessExit and removing only that record. A different process that later
    /// reuses the port is never observed or killed by this watcher.
    fn watch_process_exit(&self, port: u16, pid: u32, identity: u64) {
        let processes = self.processes.clone();
        let exits = self.exit_sender.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let exited = {
                let mut lock = match processes.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                let Some(proc) = lock.get_mut(&port) else {
                    return;
                };
                if proc.pid != pid || proc.identity != identity {
                    return;
                }
                matches!(proc.child.try_wait(), Ok(Some(_)))
            };
            if exited {
                let mut lock = match processes.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                if let Some(proc) = lock.get(&port) {
                    if proc.pid == pid && proc.identity == identity {
                        lock.remove(&port);
                    }
                }
                drop(lock);
                let _ = exits.send(ProcessExit {
                    port,
                    pid,
                    identity,
                });
                return;
            }
        });
    }

    #[allow(dead_code)]
    pub fn subscribe_exits(&self) -> broadcast::Receiver<ProcessExit> {
        self.exit_sender.subscribe()
    }

    pub fn subscribe_rpc_outputs(&self) -> broadcast::Receiver<RpcOutput> {
        self.rpc_output_sender.subscribe()
    }

    #[allow(dead_code)]
    pub fn matches_process(&self, port: u16, pid: u32) -> bool {
        let lock = self.processes.lock().unwrap();
        lock.get(&port).is_some_and(|p| p.pid == pid)
    }

    pub fn matches_process_identity(&self, port: u16, pid: u32, identity: u64) -> bool {
        let lock = self.processes.lock().unwrap();
        lock.get(&port)
            .is_some_and(|p| p.pid == pid && p.identity == identity)
    }

    /// Whether this manager owns a live process at the given port.
    pub fn owns_process(&self, port: u16) -> bool {
        self.processes.lock().unwrap().contains_key(&port)
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

    /// Return the cached `get_available_models` payload, if any. Shared across
    /// all windows/chats so dropdowns populate instantly without re-querying
    /// every Pi instance.
    pub fn cached_models(&self) -> Option<CachedModels> {
        self.model_cache.lock().unwrap().clone()
    }

    /// Store a fresh `get_available_models` payload. The first Pi instance to
    /// respond wins; later calls overwrite so a newer catalog replaces a stale
    /// one. Called from the host after subscribing to RPC output.
    pub fn store_cached_models(&self, source_port: u16, payload: serde_json::Value) {
        let cached = CachedModels {
            source_port,
            payload,
            cached_at: std::time::Instant::now(),
        };
        let mut lock = self.model_cache.lock().unwrap();
        *lock = Some(cached);
        log::info!(
            "[pi-desktop] model cache populated: source_port={} models={}",
            source_port,
            lock.as_ref()
                .and_then(|c| c
                    .payload
                    .get("models")
                    .and_then(|m| m.as_array())
                    .map(|m| m.len()))
                .unwrap_or(0)
        );
    }

    /// Drop the cached payload. Called when API keys change, package sources
    /// are installed/removed, or any other event that could alter the model
    /// registry. The next `get_available_models` RPC repopulates the cache.
    pub fn invalidate_cached_models(&self) {
        let mut lock = self.model_cache.lock().unwrap();
        if lock.is_some() {
            log::info!("[pi-desktop] model cache invalidated");
        }
        *lock = None;
    }

    /// Returns `Some(exit_status_string)` if the process has already exited, `None` if still running.
    pub fn check_exited(&self, port: u16) -> Option<String> {
        let mut lock = self.processes.lock().unwrap();
        let proc = lock.get_mut(&port)?;
        match proc.child.try_wait() {
            Ok(Some(status)) => Some(format!("{}", status)),
            _ => None,
        }
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

    // ── Standby pool ──────────────────────────────────────────────────────────
    //
    // Pre-spawned pi processes held in reserve so Side Chat / Quick Chat
    // creation feels instant. The pool is keyed by (cwd, no_tools): a Side
    // Chat standby (workspace cwd, tools enabled) cannot serve a Quick Chat
    // (temp cwd, no tools) and vice versa.

    pub fn begin_standby_warm(
        &self,
        cwd: Option<&Path>,
        no_tools: bool,
    ) -> Option<StandbyWarmLease> {
        self.cleanup_expired_standby();
        let key = StandbyWarmKey {
            cwd: cwd.map(Path::to_path_buf),
            no_tools,
        };
        let mut warming = self.standby_warming.lock().unwrap();
        if warming.contains_key(&key) || self.has_matching_standby(&key) {
            return None;
        }
        let generation = self.next_standby_warm.fetch_add(1, Ordering::Relaxed);
        warming.insert(key.clone(), generation);
        Some(StandbyWarmLease { key, generation })
    }

    pub fn cancel_standby_warm_for_cwd(&self, cwd: &Path) {
        self.standby_warming
            .lock()
            .unwrap()
            .retain(|key, _| key.cwd.as_deref() != Some(cwd));
    }

    pub fn cancel_standby_warm(&self, lease: &StandbyWarmLease) {
        self.finish_standby_warm(lease);
    }

    /// Pre-spawn a pi process with the given cwd and flags, wait for it to
    /// become healthy, then park it in the standby pool. A canceled lease
    /// discards the child instead of reviving an obsolete workspace standby.
    pub fn spawn_standby(
        &self,
        lease: StandbyWarmLease,
        cwd: PathBuf,
        no_tools: bool,
        temp_dir: Option<(PathBuf, String)>,
        environment: Vec<(String, String)>,
    ) -> Result<(), String> {
        let port = self.next_port();
        let cleanup_temp_dir = temp_dir.clone();
        let result = (|| {
            let spec = PiSpawnSpec {
                cwd: cwd.clone(),
                port,
                session_path: None,
                no_session: true,
                no_tools,
                environment,
            };
            let spawned = self.spawn_with_spec(&spec)?;
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                if std::time::Instant::now() > deadline {
                    return Err(format!(
                        "Timed out waiting for standby health on port {}",
                        port
                    ));
                }
                if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            if !self.process_is_live_identity(spawned) {
                return Err("standby pi exited during startup".to_string());
            }
            let entry = StandbyEntry {
                cwd,
                no_tools,
                spawned,
                temp_dir,
                created_at: std::time::Instant::now(),
            };
            if let Err(entry) = self.park_standby(&lease, entry) {
                self.cleanup_standby_entry(entry);
                return Err("standby warm was canceled".to_string());
            }
            Ok(())
        })();
        if result.is_err() {
            self.finish_standby_warm(&lease);
            self.cleanup_standby_resources(port, cleanup_temp_dir);
        }
        result
    }

    /// Adopt the oldest live standby matching the requested chat kind. Quick
    /// Chat entries match by `no_tools` because each standby owns its own temp
    /// directory; Side Chat entries also require the workspace cwd to match.
    pub fn take_standby(
        &self,
        cwd: &Path,
        no_tools: bool,
    ) -> Option<(SpawnedPi, Option<(PathBuf, String)>)> {
        self.cleanup_expired_standby();
        loop {
            let entry = {
                let mut pool = self.standby_pool.lock().unwrap();
                let pos = pool
                    .iter()
                    .position(|entry| standby_matches(entry, cwd, no_tools))?;
                pool.remove(pos)
            };
            if self.process_is_live_identity(entry.spawned) {
                log::info!(
                    "[pi-desktop] standby pi adopted: port={}",
                    entry.spawned.port
                );
                return Some((entry.spawned, entry.temp_dir));
            }
            log::warn!(
                "[pi-desktop] standby pi died before adoption: port={}",
                entry.spawned.port
            );
            self.cleanup_standby_entry(entry);
        }
    }

    /// Kill all Side Chat standby processes for one workspace and invalidate
    /// any in-flight warmer so it cannot repopulate the old workspace later.
    pub fn kill_standby_for_cwd(&self, cwd: &Path) {
        self.cancel_standby_warm_for_cwd(cwd);
        let entries = self.drain_standby(|entry| entry.cwd == *cwd && !entry.no_tools);
        for entry in entries {
            self.cleanup_standby_entry(entry);
        }
    }

    /// Kill the unowned Quick Chat standby when a workspace window closes. It
    /// is only a latency optimization, so another window may warm a fresh one.
    pub fn kill_quick_standby(&self) {
        let key = StandbyWarmKey {
            cwd: None,
            no_tools: true,
        };
        self.standby_warming.lock().unwrap().remove(&key);
        let entries = self.drain_standby(|entry| entry.no_tools);
        for entry in entries {
            self.cleanup_standby_entry(entry);
        }
    }

    /// Remove a standby entry when its exact child exits naturally. This keeps
    /// dead entries from blocking a replacement warm-up and releases any Quick
    /// Chat temporary directory owned by the entry.
    pub fn cleanup_exited_standby(&self, exit: ProcessExit) -> bool {
        let entries = self.drain_standby(|entry| {
            entry.spawned.port == exit.port
                && entry.spawned.pid == exit.pid
                && entry.spawned.identity == exit.identity
        });
        let removed = !entries.is_empty();
        for entry in entries {
            self.cleanup_standby_entry(entry);
        }
        removed
    }

    /// Kill every standby process and invalidate all in-flight warmers. Quick
    /// Chat directories are deleted before the application exits.
    pub fn kill_all_standby(&self) {
        self.standby_warming.lock().unwrap().clear();
        let entries = self.drain_standby(|_| true);
        let count = entries.len();
        for entry in entries {
            self.cleanup_standby_entry(entry);
        }
        if count > 0 {
            log::info!("[pi-desktop] killed {} standby pi(s) on shutdown", count);
        }
    }

    fn finish_standby_warm(&self, lease: &StandbyWarmLease) {
        let mut warming = self.standby_warming.lock().unwrap();
        if warming.get(&lease.key) == Some(&lease.generation) {
            warming.remove(&lease.key);
        }
    }

    fn has_matching_standby(&self, key: &StandbyWarmKey) -> bool {
        self.standby_pool.lock().unwrap().iter().any(|entry| {
            if key.no_tools {
                entry.no_tools
            } else {
                !entry.no_tools && key.cwd.as_ref().is_some_and(|cwd| entry.cwd == *cwd)
            }
        })
    }

    fn park_standby(
        &self,
        lease: &StandbyWarmLease,
        entry: StandbyEntry,
    ) -> Result<(), StandbyEntry> {
        let mut warming = self.standby_warming.lock().unwrap();
        if warming.get(&lease.key) != Some(&lease.generation) {
            return Err(entry);
        }
        let mut pool = self.standby_pool.lock().unwrap();
        warming.remove(&lease.key);
        log::info!(
            "[pi-desktop] standby pi parked: port={} pool_size={}",
            entry.spawned.port,
            pool.len() + 1
        );
        pool.push(entry);
        Ok(())
    }

    fn cleanup_expired_standby(&self) {
        let expired =
            self.drain_standby(|entry| entry.created_at.elapsed() >= Duration::from_secs(300));
        for entry in expired {
            self.cleanup_standby_entry(entry);
        }
    }

    fn drain_standby(&self, predicate: impl Fn(&StandbyEntry) -> bool) -> Vec<StandbyEntry> {
        let mut pool = self.standby_pool.lock().unwrap();
        let mut removed = Vec::new();
        pool.retain(|entry| {
            if predicate(entry) {
                removed.push(entry.clone());
                false
            } else {
                true
            }
        });
        removed
    }

    fn cleanup_standby_entry(&self, entry: StandbyEntry) {
        self.cleanup_standby_resources(entry.spawned.port, entry.temp_dir);
    }

    fn cleanup_standby_resources(&self, port: u16, temp_dir: Option<(PathBuf, String)>) {
        self.kill(port);
        if let Some((path, token)) = temp_dir {
            let _ = cleanup_quick_chat_dir(&canonical_temp_root(), &path, &token);
        }
    }

    fn process_is_live_identity(&self, spawned: SpawnedPi) -> bool {
        let mut processes = self.processes.lock().unwrap();
        let Some(process) = processes.get_mut(&spawned.port) else {
            return false;
        };
        if process.pid != spawned.pid || process.identity != spawned.identity {
            return false;
        }
        if matches!(process.child.try_wait(), Ok(Some(_))) {
            processes.remove(&spawned.port);
            return false;
        }
        true
    }

    /// Test-only: insert a fake standby entry without spawning a real process.
    #[cfg(test)]
    pub fn insert_standby_for_test(
        &self,
        cwd: PathBuf,
        no_tools: bool,
        spawned: SpawnedPi,
        temp_dir: Option<(PathBuf, String)>,
    ) {
        let entry = StandbyEntry {
            cwd,
            no_tools,
            spawned,
            temp_dir,
            created_at: std::time::Instant::now(),
        };
        self.standby_pool.lock().unwrap().push(entry);
    }

    /// Spawn (or reuse) a dedicated pi process for a specific session file,
    /// so it can run concurrently with the workspace's primary process.
    /// Returns the port the dedicated process is listening on.
    pub fn spawn_session_dedicated(
        &self,
        workspace_port: u16,
        session_file: String,
        cwd: &str,
    ) -> Result<u16, String> {
        {
            let sp = self.session_ports.lock().unwrap();
            if let Some(&port) = sp.get(&session_file) {
                return Ok(port);
            }
        }
        let port = self.next_port();
        self.spawn(cwd, port, Some(&session_file))?;
        {
            let mut sp = self.session_ports.lock().unwrap();
            sp.insert(session_file, port);
        }
        {
            let mut wd = self.workspace_dedicated.lock().unwrap();
            wd.entry(workspace_port).or_default().push(port);
        }
        Ok(port)
    }

    /// Kill all dedicated session processes spawned for a workspace port.
    /// Called when the workspace window is destroyed.
    pub fn kill_workspace_dedicated(&self, workspace_port: u16) {
        let dedicated_ports = {
            let mut wd = self.workspace_dedicated.lock().unwrap();
            wd.remove(&workspace_port).unwrap_or_default()
        };
        for port in &dedicated_ports {
            self.kill(*port);
        }
        if !dedicated_ports.is_empty() {
            let port_set: std::collections::HashSet<u16> = dedicated_ports.into_iter().collect();
            let mut sp = self.session_ports.lock().unwrap();
            sp.retain(|_, v| !port_set.contains(v));
        }
    }

    pub fn next_port(&self) -> u16 {
        let processes = self.processes.lock().unwrap();
        let mut reserved = self.reserved_ports.lock().unwrap();
        let mut port = 47821u16;
        while processes.contains_key(&port) || reserved.contains(&port) || is_port_in_use(port) {
            port += 1;
        }
        reserved.insert(port);
        port
    }

    /// Run `pi <args...>` with the embedded binary and return stdout.
    /// Used by Settings UI package management operations (install/remove/list).
    pub fn run_pi_command(&self, args: &[String]) -> Result<String, String> {
        let pi_bin = self.resolve_bundled_pi()?;
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let augmented_path = build_augmented_path();
        log_child_path_diagnostics("run_pi_command", &augmented_path);
        let mut command = Command::new(&pi_bin_str);
        configure_child_process_for_windows(&mut command);
        command
            .args(args)
            .env("PATH", augmented_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = command.output().map_err(|e| {
            format!(
                "Failed to run embedded pi command ({} {:?}): {}",
                pi_bin_str, args, e
            )
        })?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit status {}", output.status)
        };
        Err(format!(
            "Embedded pi command failed: {} {:?}: {}",
            pi_bin_str, args, details
        ))
    }

    /// Parse `pi list` output and extract package sources.
    pub fn list_configured_package_sources(&self) -> Result<Vec<String>, String> {
        let args = vec!["list".to_string()];
        let output = self.run_pi_command(&args)?;
        Ok(parse_package_sources(&output))
    }

    pub fn install_package_source(&self, source: &str) -> Result<(), String> {
        let args = vec!["install".to_string(), source.to_string()];
        let _ = self.run_pi_command(&args)?;
        Ok(())
    }

    pub fn remove_package_source(&self, source: &str) -> Result<(), String> {
        let args = vec!["remove".to_string(), source.to_string()];
        let _ = self.run_pi_command(&args)?;
        Ok(())
    }
}

/// Parse `pi list` stdout into the list of configured package sources.
/// Pure extraction of the loop previously inlined in `list_configured_package_sources`.
fn parse_package_sources(output: &str) -> Vec<String> {
    let mut sources = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("No packages installed.") {
            continue;
        }
        if trimmed.ends_with(':') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('-') {
            let value = rest.trim();
            if !value.is_empty() {
                sources.push(value.to_string());
            }
            continue;
        }
        // `pi list` currently emits entries prefixed with two spaces.
        if let Some(value) = trimmed.strip_prefix("npm:") {
            sources.push(format!("npm:{}", value));
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("git:") {
            sources.push(format!("git:{}", value));
            continue;
        }
        if trimmed.starts_with('/') || trimmed.starts_with("./") || trimmed.starts_with("../") {
            sources.push(trimmed.to_string());
        }
    }
    sources
}

/// Build the pi CLI argument vector for a spawn spec. Pure and separately
/// tested so the side-chat / quick-chat flag combinations are locked down
/// without spawning a real process.
fn build_pi_args(extension_path: &str, spec: &PiSpawnSpec) -> Result<Vec<String>, String> {
    if spec.no_session && spec.session_path.is_some() {
        return Err("cannot combine --no-session with an explicit session path".to_string());
    }
    let mut args = vec![
        "--extension".to_string(),
        extension_path.to_string(),
        "--mode".to_string(),
        "rpc".to_string(),
    ];
    if spec.no_session {
        args.push("--no-session".to_string());
    } else if let Some(session) = &spec.session_path {
        args.push("--session".to_string());
        args.push(session.clone());
    }
    if spec.no_tools {
        args.push("--no-tools".to_string());
    }
    Ok(args)
}

/// Trusted host-injected environment markers identifying one ephemeral chat.
/// They carry no capability or owner token.
#[allow(dead_code)]
pub fn build_ephemeral_environment(
    kind: &str,
    instance_id: &str,
    generation: u64,
) -> Vec<(String, String)> {
    vec![
        ("PI_STUDIO_EPHEMERAL_KIND".to_string(), kind.to_string()),
        (
            "PI_STUDIO_EPHEMERAL_INSTANCE_ID".to_string(),
            instance_id.to_string(),
        ),
        (
            "PI_STUDIO_EPHEMERAL_GENERATION".to_string(),
            generation.to_string(),
        ),
    ]
}

pub fn canonical_temp_root() -> PathBuf {
    std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// Create a unique owner-private directory for a Quick Chat under the OS temp
/// root. Returns its canonical path plus the random ownership token that is
/// also encoded in the directory name. Picot never scans or recovers these on
/// startup; only the live in-memory record can request cleanup.
#[allow(dead_code)]
pub fn create_quick_chat_temp_dir() -> Result<(PathBuf, String), String> {
    let root = canonical_temp_root();
    loop {
        let token = random_hex_token();
        let candidate = root.join(format!("{QUICK_CHAT_TEMP_PREFIX}{token}"));
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                let canonical = candidate.canonicalize().map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        &canonical,
                        std::fs::Permissions::from_mode(0o700),
                    );
                }
                return Ok((canonical, token));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Delete exactly one Quick Chat directory after verifying it is beneath the
/// temp root, is not itself the root, is not a symlink, and its name still
/// encodes the owning token. Rejects everything else without deleting.
#[allow(dead_code)]
pub fn cleanup_quick_chat_dir(
    canonical_temp_root: &Path,
    exact_path: &Path,
    ownership_token: &str,
) -> Result<(), String> {
    // Reject a symlink swapped in at the stored path before canonicalize
    // (canonicalize follows the link and would hide the replacement).
    let input_meta = std::fs::symlink_metadata(exact_path).map_err(|e| e.to_string())?;
    if input_meta.file_type().is_symlink() {
        return Err("refusing to delete a symlink".to_string());
    }
    let canonical = exact_path.canonicalize().map_err(|e| e.to_string())?;
    if canonical == canonical_temp_root {
        return Err("refusing to delete the temporary root".to_string());
    }
    if !canonical.starts_with(canonical_temp_root) {
        return Err("path is outside the temporary root".to_string());
    }
    let expected_name = format!("{QUICK_CHAT_TEMP_PREFIX}{ownership_token}");
    let actual_name = canonical.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if actual_name != expected_name {
        return Err("ownership token mismatch".to_string());
    }
    std::fs::remove_dir_all(&canonical).map_err(|e| e.to_string())
}

#[allow(dead_code)]
fn random_hex_token() -> String {
    let mut bytes = [0u8; QUICK_CHAT_TOKEN_BYTES];
    OsRng.fill_bytes(&mut bytes);
    hex_encode(&bytes)
}

#[allow(dead_code)]
fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn is_port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(format!("0.0.0.0:{}", port)).is_err()
}

pub async fn wait_for_health(port: u16, timeout_secs: u64) -> Result<(), String> {
    wait_for_endpoint(port, "/api/health", timeout_secs).await
}

/// Wait for a specific HTTP endpoint on the pi instance to respond with a non-5xx status.
/// Useful when we need to confirm the API surface the frontend will hit first (e.g. /api/sessions)
/// is ready before navigating, avoiding cold-start races where /api/health is up but route
/// handlers are still warming.
pub async fn wait_for_endpoint(port: u16, path: &str, timeout_secs: u64) -> Result<(), String> {
    // A dedicated client with `.no_proxy()`: the embedded pi is a localhost
    // loopback service, so the request must never traverse a system HTTP proxy
    // (e.g. Clash/ClashX on 127.0.0.1:7890). The default `reqwest::get` honors
    // HTTP_PROXY/HTTPS_PROXY env vars and, on macOS, the system proxy config —
    // which routes the loopback request through the proxy. The proxy can't
    // reach the upstream and returns `502 Bad Gateway` with an empty body,
    // which the old `status < 500` check kept retrying until the deadline,
    // making Picot appear to hang forever on startup with no window.
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
    let url = format!("http://localhost:{}{}", port, path);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!("Timed out waiting for {} on port {}", path, port));
        }
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().as_u16() < 500 {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

    #[test]
    fn augmented_path_includes_pi_extension_npm_bin() {
        let home = std::env::var("HOME").expect("HOME must be set for this test");
        let expected = Path::new(&home)
            .join(".pi")
            .join("agent")
            .join("npm")
            .join("node_modules")
            .join(".bin");

        let path = build_augmented_path();
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();

        assert!(
            dirs.iter().any(|dir| dir == &expected),
            "expected augmented PATH to include {}",
            expected.display()
        );
    }

    #[test]
    fn port_in_use_detects_unspecified_ipv4_listener() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
            .expect("bind ephemeral port");
        let port = listener.local_addr().expect("listener addr").port();

        assert!(is_port_in_use(port));
    }

    #[test]
    fn next_port_starts_at_or_above_47821() {
        // Empty manager must hand out a port in the documented range; a
        // regression that returns 0 or some unrelated port would make the
        // WebView fail to load the embedded pi instance.
        let manager = PiManager::new(PathBuf::from("."));
        let port = manager.next_port();
        assert!(port >= 47821, "next_port must be >= 47821, got {}", port);
    }

    #[test]
    fn next_port_reserves_its_result_until_spawn_claims_it() {
        let manager = Arc::new(PiManager::new(PathBuf::from(".")));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let first_manager = manager.clone();
        let first_barrier = barrier.clone();
        let first = std::thread::spawn(move || {
            first_barrier.wait();
            first_manager.next_port()
        });
        let second_manager = manager.clone();
        let second_barrier = barrier.clone();
        let second = std::thread::spawn(move || {
            second_barrier.wait();
            second_manager.next_port()
        });

        barrier.wait();
        assert_ne!(first.join().unwrap(), second.join().unwrap());
    }

    #[test]
    fn is_port_in_use_roundtrip() {
        // is_port_in_use probes 0.0.0.0:port, so bind on the unspecified
        // IPv4 address to mirror what production listeners do.
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
            .expect("bind ephemeral port");
        let port = listener.local_addr().expect("listener addr").port();

        assert!(
            is_port_in_use(port),
            "freshly bound port must report in use"
        );
        drop(listener);
        // The OS may reuse the port immediately after drop, so we only assert
        // the listener-bound case.
    }

    #[test]
    fn parse_package_sources_handles_every_branch() {
        // Empty / whitespace-only → no sources.
        assert_eq!(parse_package_sources(""), Vec::<String>::new());
        assert_eq!(parse_package_sources("   \n  \n"), Vec::<String>::new());

        // "No packages installed." sentinel is skipped (case-insensitive).
        assert_eq!(
            parse_package_sources("No packages installed."),
            Vec::<String>::new()
        );
        assert_eq!(
            parse_package_sources("no packages installed."),
            Vec::<String>::new()
        );

        // Section headers ending in ':' are skipped.
        assert_eq!(
            parse_package_sources("Installed packages:"),
            Vec::<String>::new()
        );

        // '-' prefixed → value after '-', trimmed.
        assert_eq!(parse_package_sources("- @scope/pkg"), vec!["@scope/pkg"]);
        assert_eq!(parse_package_sources("-  spaced"), vec!["spaced"]);
        // bare '-' (empty value) is dropped, not emitted.
        assert_eq!(parse_package_sources("-"), Vec::<String>::new());

        // npm: / git: prefixes preserved with their scheme.
        assert_eq!(parse_package_sources("npm:foo"), vec!["npm:foo"]);
        assert_eq!(
            parse_package_sources("git:https://github.com/x/y"),
            vec!["git:https://github.com/x/y"],
        );

        // Absolute / ./ / ../ paths kept; bare names dropped.
        assert_eq!(parse_package_sources("/abs/pkg"), vec!["/abs/pkg"]);
        assert_eq!(parse_package_sources("./local"), vec!["./local"]);
        assert_eq!(parse_package_sources("../parent"), vec!["../parent"]);
        assert_eq!(parse_package_sources("bare-name"), Vec::<String>::new());

        // Mixed realistic block: headers + two-space indent + sentinel, order preserved.
        let mixed = "\
Installed packages:
- @scope/pkg
  npm:foo
  git:https://github.com/x/y
  /abs/pkg
No packages installed.";
        assert_eq!(
            parse_package_sources(mixed),
            vec![
                "@scope/pkg",
                "npm:foo",
                "git:https://github.com/x/y",
                "/abs/pkg",
            ],
        );
    }

    fn spec(no_session: bool, no_tools: bool, session_path: Option<&str>) -> PiSpawnSpec {
        PiSpawnSpec {
            cwd: PathBuf::from("/workspace"),
            port: 47821,
            session_path: session_path.map(|s| s.to_string()),
            no_session,
            no_tools,
            environment: vec![],
        }
    }

    #[test]
    fn build_pi_args_normal_sessionless_spawn() {
        let args = build_pi_args("/ext/server.mjs", &spec(false, false, None)).unwrap();
        assert_eq!(
            args,
            vec![
                "--extension".to_string(),
                "/ext/server.mjs".to_string(),
                "--mode".to_string(),
                "rpc".to_string(),
            ]
        );
    }

    #[test]
    fn build_pi_args_persisted_session_adds_session_flag() {
        let args = build_pi_args("/ext/server.mjs", &spec(false, false, Some("/s.jsonl"))).unwrap();
        assert_eq!(
            args,
            vec![
                "--extension".to_string(),
                "/ext/server.mjs".to_string(),
                "--mode".to_string(),
                "rpc".to_string(),
                "--session".to_string(),
                "/s.jsonl".to_string(),
            ]
        );
    }

    #[test]
    fn build_pi_args_side_chat_uses_no_session_only() {
        let args = build_pi_args("/ext/server.mjs", &spec(true, false, None)).unwrap();
        assert!(args.contains(&"--no-session".to_string()));
        assert!(!args.contains(&"--no-tools".to_string()));
        assert!(!args.contains(&"--session".to_string()));
    }

    #[test]
    fn build_pi_args_quick_chat_uses_no_session_and_no_tools() {
        let args = build_pi_args("/ext/server.mjs", &spec(true, true, None)).unwrap();
        assert!(args.contains(&"--no-session".to_string()));
        assert!(args.contains(&"--no-tools".to_string()));
    }

    #[test]
    fn build_pi_args_rejects_no_session_with_explicit_session_path() {
        assert!(build_pi_args("/ext/server.mjs", &spec(true, false, Some("/s.jsonl"))).is_err());
    }

    #[test]
    fn ephemeral_environment_markers_carry_no_capability_or_token() {
        let env = build_ephemeral_environment("side-chat", "inst-123", 7);
        let serialized = format!("{env:?}");
        assert!(serialized.contains("side-chat"));
        assert!(serialized.contains("inst-123"));
        assert!(serialized.contains("7"));
        for key in env.iter().map(|(k, _)| k.as_str()) {
            assert!(!key.to_ascii_lowercase().contains("capabilit"));
            assert!(!key.to_ascii_lowercase().contains("token"));
            assert!(!key.to_ascii_lowercase().contains("owner"));
        }
    }

    #[test]
    fn matches_process_is_false_for_empty_manager() {
        let manager = PiManager::new(PathBuf::from("."));
        assert!(!manager.matches_process(47821, 12345));
    }

    #[test]
    fn quick_chat_temp_dir_create_and_cleanup_roundtrip() {
        let root = canonical_temp_root();
        let (path, token) = create_quick_chat_temp_dir().expect("create temp dir");
        assert!(path.starts_with(&root));
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()).unwrap(),
            format!("{QUICK_CHAT_TEMP_PREFIX}{token}")
        );
        assert!(path.is_dir());
        cleanup_quick_chat_dir(&root, &path, &token).expect("cleanup owned dir");
        assert!(!path.exists());
    }

    #[test]
    fn quick_chat_cleanup_rejects_root_itself() {
        let root = canonical_temp_root();
        assert!(cleanup_quick_chat_dir(&root, &root, "any").is_err());
    }

    #[test]
    fn quick_chat_cleanup_rejects_outside_root() {
        let outside = PathBuf::from("/etc");
        let root = std::env::temp_dir();
        assert!(cleanup_quick_chat_dir(&root, &outside, "x").is_err());
    }

    #[test]
    fn quick_chat_cleanup_rejects_symlink_replacement() {
        let root = canonical_temp_root();
        let (real, token) = create_quick_chat_temp_dir().unwrap();
        let link = root.join(format!("picot-quick-chat-link-{}", random_hex_token()));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(not(unix))]
        {
            let _ = (real, token);
            return;
        }
        assert!(cleanup_quick_chat_dir(&root, &link, &token).is_err());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn quick_chat_cleanup_rejects_token_mismatch() {
        let root = canonical_temp_root();
        let (path, _token) = create_quick_chat_temp_dir().unwrap();
        // A real picot-quick-chat dir but with a non-matching ownership token.
        assert!(cleanup_quick_chat_dir(&root, &path, "deadbeef").is_err());
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn model_cache_starts_empty() {
        let manager = PiManager::new(PathBuf::from("."));
        assert!(manager.cached_models().is_none());
    }

    #[test]
    fn store_cached_models_round_trips_payload_and_source_port() {
        let manager = PiManager::new(PathBuf::from("."));
        let payload = serde_json::json!({
            "models": [
                {"provider": "openai", "id": "gpt-4o"},
                {"provider": "anthropic", "id": "claude-3"},
            ]
        });
        manager.store_cached_models(47821, payload.clone());
        let cached = manager.cached_models().expect("cached payload");
        assert_eq!(cached.source_port, 47821);
        assert_eq!(cached.payload, payload);
        assert_eq!(cached.payload["models"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn invalidate_cached_models_clears_payload() {
        let manager = PiManager::new(PathBuf::from("."));
        manager.store_cached_models(47821, serde_json::json!({"models": []}));
        assert!(manager.cached_models().is_some());
        manager.invalidate_cached_models();
        assert!(manager.cached_models().is_none());
    }

    #[test]
    fn store_cached_models_overwrites_previous_payload() {
        let manager = PiManager::new(PathBuf::from("."));
        manager.store_cached_models(47821, serde_json::json!({"models": [{"id": "old"}]}));
        manager.store_cached_models(47822, serde_json::json!({"models": [{"id": "new"}]}));
        let cached = manager.cached_models().expect("cached payload");
        assert_eq!(cached.source_port, 47822);
        assert_eq!(cached.payload["models"][0]["id"], "new");
    }

    #[test]
    fn standby_pool_starts_empty() {
        let manager = PiManager::new(PathBuf::from("."));
        assert!(manager.take_standby(&PathBuf::from("/ws"), false).is_none());
        assert!(manager.take_standby(&PathBuf::from("/ws"), true).is_none());
    }

    #[test]
    fn standby_pool_rejects_an_unmanaged_process() {
        let manager = PiManager::new(PathBuf::from("."));
        let cwd = PathBuf::from("/workspace");
        manager.insert_standby_for_test(
            cwd.clone(),
            false,
            SpawnedPi {
                port: 47850,
                pid: 12345,
                identity: 1,
            },
            None,
        );

        assert!(manager.take_standby(&cwd, false).is_none());
    }

    #[test]
    fn standby_pool_rejects_mismatched_cwd() {
        let manager = PiManager::new(PathBuf::from("."));
        manager.insert_standby_for_test(
            PathBuf::from("/workspace-a"),
            false,
            SpawnedPi {
                port: 47850,
                pid: 1,
                identity: 1,
            },
            None,
        );
        // Different cwd → no match.
        assert!(manager
            .take_standby(&PathBuf::from("/workspace-b"), false)
            .is_none());
    }

    #[test]
    fn standby_pool_rejects_mismatched_tools_flag() {
        let manager = PiManager::new(PathBuf::from("."));
        manager.insert_standby_for_test(
            PathBuf::from("/ws"),
            false,
            SpawnedPi {
                port: 47850,
                pid: 1,
                identity: 1,
            },
            None,
        );
        // Same cwd but different no_tools → no match (Side Chat standby
        // cannot serve Quick Chat which needs --no-tools, and vice versa).
        assert!(manager.take_standby(&PathBuf::from("/ws"), true).is_none());
    }

    #[test]
    fn standby_pool_cleans_expired_quick_chat_directory() {
        let manager = PiManager::new(PathBuf::from("."));
        let (path, token) = create_quick_chat_temp_dir().expect("temp dir");
        manager.standby_pool.lock().unwrap().push(StandbyEntry {
            cwd: path.clone(),
            no_tools: true,
            spawned: SpawnedPi {
                port: 47851,
                pid: 99,
                identity: 2,
            },
            temp_dir: Some((path.clone(), token.clone())),
            created_at: Instant::now() - Duration::from_secs(301),
        });

        assert!(manager.take_standby(&path, true).is_none());
        let cleaned = !path.exists();
        if path.exists() {
            let _ = cleanup_quick_chat_dir(&canonical_temp_root(), &path, &token);
        }
        assert!(cleaned, "expired standby directory must be removed");
    }

    #[test]
    fn standby_warming_is_single_flight_and_cancellable() {
        let manager = PiManager::new(PathBuf::from("."));
        let cwd = PathBuf::from("/workspace");

        assert!(manager.begin_standby_warm(Some(&cwd), false).is_some());
        assert!(manager.begin_standby_warm(Some(&cwd), false).is_none());
        manager.cancel_standby_warm_for_cwd(&cwd);
        assert!(manager.begin_standby_warm(Some(&cwd), false).is_some());
    }

    #[test]
    fn canceled_warmer_cannot_park_a_late_side_chat() {
        let manager = PiManager::new(PathBuf::from("."));
        let cwd = PathBuf::from("/workspace");
        let lease = manager
            .begin_standby_warm(Some(&cwd), false)
            .expect("warm lease");
        manager.cancel_standby_warm_for_cwd(&cwd);
        let entry = StandbyEntry {
            cwd,
            no_tools: false,
            spawned: SpawnedPi {
                port: 47852,
                pid: 100,
                identity: 3,
            },
            temp_dir: None,
            created_at: Instant::now(),
        };

        assert!(manager.park_standby(&lease, entry).is_err());
    }

    #[test]
    fn natural_exit_cleans_a_quick_chat_standby_directory() {
        let manager = PiManager::new(PathBuf::from("."));
        let (path, token) = create_quick_chat_temp_dir().expect("temp dir");
        manager.insert_standby_for_test(
            path.clone(),
            true,
            SpawnedPi {
                port: 47853,
                pid: 101,
                identity: 4,
            },
            Some((path.clone(), token.clone())),
        );

        manager.cleanup_exited_standby(ProcessExit {
            port: 47853,
            pid: 101,
            identity: 4,
        });

        let cleaned = !path.exists();
        if path.exists() {
            let _ = cleanup_quick_chat_dir(&canonical_temp_root(), &path, &token);
        }
        assert!(cleaned, "natural exit must remove the standby directory");
    }

    #[test]
    fn workspace_close_cleans_quick_chat_standby_directory() {
        let manager = PiManager::new(PathBuf::from("."));
        let (path, token) = create_quick_chat_temp_dir().expect("temp dir");
        manager.insert_standby_for_test(
            path.clone(),
            true,
            SpawnedPi {
                port: 47854,
                pid: 102,
                identity: 5,
            },
            Some((path.clone(), token.clone())),
        );

        manager.kill_quick_standby();

        let cleaned = !path.exists();
        if path.exists() {
            let _ = cleanup_quick_chat_dir(&canonical_temp_root(), &path, &token);
        }
        assert!(cleaned, "window close must remove the standby directory");
    }
}
