use crate::native_pi_manager::NativeLaunchSpec;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

mod extensions;

use extensions::resolve_bundled_extensions;

const PI_VERSION_JSON: &str = include_str!("../../scripts/pi-version.json");

/// A single configured pi package source with its resolved install path.
/// `scope` is "global" (user) or "project" (local to a workspace).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiPackageInfo {
    pub source: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_path: Option<String>,
    /// True when the package entry is disabled (object form with all-empty resource arrays).
    pub disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Number of resolved extensions/skills/prompts/themes contributed by this
    /// package (read from its `pi` manifest or conventional dirs when installed).
    #[serde(skip_serializing_if = "PackageResourceCounts::is_zero")]
    pub counts: PackageResourceCounts,
    /// The individual resolved resources (entry file per extension/skill/prompt/theme).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<ResourceEntry>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackageResourceCounts {
    pub extensions: usize,
    pub skills: usize,
    pub prompts: usize,
    pub themes: usize,
}

impl PackageResourceCounts {
    fn is_zero(&self) -> bool {
        self.extensions == 0 && self.skills == 0 && self.prompts == 0 && self.themes == 0
    }

    fn from_resources(resources: &[ResourceEntry]) -> Self {
        let mut counts = PackageResourceCounts::default();
        for entry in resources {
            match entry.kind.as_str() {
                "extension" => counts.extensions += 1,
                "skill" => counts.skills += 1,
                "prompt" => counts.prompts += 1,
                "theme" => counts.themes += 1,
                _ => {}
            }
        }
        counts
    }
}

/// A single resolved resource contributed by an installed package — one entry
/// per extension/skill/prompt/theme, with the file (or skill dir) it resolves to.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEntry {
    pub kind: String,
    pub name: String,
    pub relative_path: String,
}

pub fn locked_pi_version() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(|| {
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

#[derive(Clone)]
pub struct PiLaunchResolver {
    static_dir: PathBuf,
}

impl PiLaunchResolver {
    pub fn new(static_dir: PathBuf) -> Self {
        Self { static_dir }
    }

    pub fn native_launch_spec(
        &self,
        cwd: &str,
        session_path: Option<&str>,
    ) -> Result<NativeLaunchSpec, String> {
        let binary = self.resolve_bundled_pi()?;
        let extensions =
            resolve_bundled_extensions(&self.static_dir, Path::new(cwd), session_path.is_some())?;
        Ok(NativeLaunchSpec {
            binary,
            cwd: PathBuf::from(strip_verbatim_prefix(cwd)),
            session_path: session_path.map(|path| PathBuf::from(strip_verbatim_prefix(path))),
            extensions,
            pi_version: locked_pi_version().to_owned(),
            path_env: build_augmented_path(),
            // Picot workspaces are opened via the OS folder picker, so the user
            // has already opted in; trust project-local resources for every
            // pi process Picot spawns.
            approve: true,
        })
    }

    /// Run the embedded `pi` CLI with the given arguments and return trimmed stdout.
    /// Blocking; callers on an async runtime should wrap this in `spawn_blocking`.
    pub fn run_pi_command(&self, args: &[&str]) -> Result<String, String> {
        let pi_bin = self.resolve_bundled_pi()?;
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let augmented_path = build_augmented_path();
        let mut command = Command::new(&pi_bin_str);
        crate::windows_child::hide_console(&mut command);
        crate::appimage_env::scrub(&mut command);
        command
            .args(args)
            .env("PATH", augmented_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = command.output().map_err(|error| {
            format!("Failed to run embedded pi command ({pi_bin_str} {args:?}): {error}")
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
            "Embedded pi command failed: {pi_bin_str} {args:?}: {details}"
        ))
    }

    /// Parse `pi list` output into a list of configured packages with their
    /// resolved install paths and scope. `pi list` prints lines shaped like:
    ///
    /// ```text
    /// User packages:            (scope section header)
    ///   npm:pi-web-access
    ///     /Users/me/.pi/agent/npm/node_modules/pi-web-access
    ///   - npm:disabled-pkg       (a disabled / filtered entry may be prefixed)
    /// ```
    ///
    /// Any leading dashes are stripped from sources. Indented non-source lines
    /// are treated as resolved install paths for the current package.
    pub fn list_pi_packages(&self) -> Result<Vec<PiPackageInfo>, String> {
        let output = self.run_pi_command(&["list"])?;
        let mut packages: Vec<PiPackageInfo> = Vec::new();
        let mut scope = "global";
        for line in output.lines() {
            let leading = line.len() - line.trim_start().len();
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("No packages installed.") {
                continue;
            }
            if trimmed.ends_with(':') {
                // Section header — "User packages:" / "Project packages:" etc.
                let lower = trimmed.to_ascii_lowercase();
                if lower.starts_with("project") {
                    scope = "project";
                } else if lower.starts_with("user") || lower.starts_with("global") {
                    scope = "global";
                }
                continue;
            }
            // Resolved install paths are indented relative to their source line.
            if leading >= 4 && !packages.is_empty() {
                let value = trimmed.strip_prefix('-').map(str::trim).unwrap_or(trimmed);
                if !value.is_empty() && packages.last().unwrap().installed_path.is_none() {
                    packages.last_mut().unwrap().installed_path = Some(value.to_string());
                }
                continue;
            }
            let source = trimmed.strip_prefix('-').map(str::trim).unwrap_or(trimmed);
            if source.is_empty() {
                continue;
            }
            packages.push(PiPackageInfo {
                source: source.to_string(),
                scope: scope.to_string(),
                installed_path: None,
                disabled: false,
                package_name: None,
                version: None,
                description: None,
                counts: PackageResourceCounts::default(),
                resources: Vec::new(),
            });
        }
        // Enrich each package with package.json metadata (when installed).
        for pkg in packages.iter_mut() {
            if let Some(path) = pkg.installed_path.as_deref() {
                let metadata = read_package_metadata(path);
                pkg.package_name = metadata.name;
                pkg.version = metadata.version;
                pkg.description = metadata.description;
                pkg.resources = read_package_resources(path);
                pkg.counts = PackageResourceCounts::from_resources(&pkg.resources);
            }
        }
        Ok(packages)
    }

    pub fn install_pi_package(&self, source: &str, local: bool) -> Result<(), String> {
        if local {
            self.run_pi_command(&["install", source, "-l"]).map(|_| ())
        } else {
            self.run_pi_command(&["install", source]).map(|_| ())
        }
    }

    pub fn remove_pi_package(&self, source: &str, local: bool) -> Result<(), String> {
        if local {
            self.run_pi_command(&["remove", source, "-l"]).map(|_| ())
        } else {
            self.run_pi_command(&["remove", source]).map(|_| ())
        }
    }

    /// Update a single installed package (or pi itself when `source` is empty).
    pub fn update_pi_package(&self, source: &str) -> Result<(), String> {
        let source = source.trim();
        if source.is_empty() {
            self.run_pi_command(&["update", "--extensions"]).map(|_| ())
        } else {
            self.run_pi_command(&["update", source]).map(|_| ())
        }
    }

    /// Resolve the bundled `pi` binary path (as a spawnable command string,
    /// with any Windows verbatim prefix stripped) and its augmented `PATH`
    /// env var. Exposed for callers (e.g. model connectivity checks) that
    /// need to spawn the embedded CLI directly rather than through
    /// `run_pi_command`.
    pub fn resolve_bundled_pi_for_spawn(&self) -> Result<(String, String), String> {
        let binary = self.resolve_bundled_pi()?;
        let binary_str = strip_verbatim_prefix(&binary.to_string_lossy());
        Ok((binary_str, build_augmented_path()))
    }

    pub fn bundled_pi_path(&self) -> Result<PathBuf, String> {
        self.resolve_bundled_pi()
    }

    fn resolve_bundled_pi(&self) -> Result<PathBuf, String> {
        let bin_name = if cfg!(target_os = "windows") {
            "pi.exe"
        } else {
            "pi"
        };

        if let Ok(explicit) = std::env::var("PI_BIN") {
            let candidate = PathBuf::from(explicit.trim());
            if candidate.is_file() {
                return Ok(candidate);
            }
        }

        let mut tried = Vec::new();
        if let Some(candidate) = self
            .static_dir
            .parent()
            .map(|parent| parent.join("pi").join(bin_name))
        {
            if candidate.is_file() {
                return Ok(candidate);
            }
            tried.push(candidate);
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

        Err(format!(
            "Could not find embedded pi binary. Tried:\n{}\n\n\
             For dev: run `bun run fetch:pi` from the repo root.\n\
             For release: the .app bundle is missing `resources/pi/{bin_name}`. \
             Reinstall Picot.",
            tried
                .iter()
                .map(|path| format!("  - {}", path.display()))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }
}

fn build_augmented_path() -> String {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    crate::appimage_env::strip_bundle_path_entries(&mut dirs);

    #[cfg(not(target_os = "windows"))]
    {
        let mut extras = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];

        if let Ok(home) = std::env::var("HOME") {
            let home = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(home));
            extras.push(home.join(".local/bin"));
            extras.push(home.join(".bun/bin"));
            extras.push(home.join(".volta/bin"));
            extras.push(home.join(".cargo/bin"));
            extras.push(home.join(".local/share/mise/shims"));
            let nvm_root = home.join(".nvm/versions/node");
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
            if !dirs.iter().any(|dir| dir == &extra) {
                dirs.push(extra);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut extras = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(Path::new(&appdata).join("npm"));
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            let home = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(home));
            extras.push(home.join(".cargo").join("bin"));
            extras.push(home.join(".bun").join("bin"));
            extras.push(home.join("scoop").join("shims"));
        }
        for extra in extras {
            if !dirs.iter().any(|dir| dir == &extra) {
                dirs.push(extra);
            }
        }
    }

    std::env::join_paths(dirs)
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppTarget {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub app_name: Option<String>,
    pub command: Option<String>,
}

#[cfg(target_os = "macos")]
fn macos_installed_app_names() -> HashSet<String> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    let mut names = HashSet::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                names.insert(stem.to_ascii_lowercase());
            }
        }
    }
    names
}

/// List launch targets Picot can use to open a workspace in an external app.
pub fn list_installed_apps() -> Vec<AppTarget> {
    let candidates: [(&str, &str, &[&str], &str); 6] = [
        ("vscode", "VS Code", &["Visual Studio Code", "Code"], "code"),
        ("cursor", "Cursor", &["Cursor"], "cursor"),
        (
            "webstorm",
            "WebStorm",
            &["WebStorm", "WebStorm EAP"],
            "webstorm",
        ),
        ("zed", "Zed", &["Zed"], "zed"),
        ("terminal", "Terminal", &["Terminal", "iTerm", "Warp"], ""),
        ("ghostty", "Ghostty", &["Ghostty"], ""),
    ];

    #[cfg(target_os = "macos")]
    {
        let installed = macos_installed_app_names();
        let mut targets = Vec::new();
        for (id, label, bundle_names, _command) in candidates {
            if let Some(app_name) = bundle_names
                .iter()
                .find(|name| installed.contains(&name.to_ascii_lowercase()))
            {
                targets.push(AppTarget {
                    id: id.to_string(),
                    label: label.to_string(),
                    kind: "app".to_string(),
                    app_name: Some((*app_name).to_string()),
                    command: None,
                });
            }
        }
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "Finder".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut targets: Vec<AppTarget> = candidates
            .iter()
            .filter(|(_, _, _, command)| !command.is_empty())
            .map(|(id, label, _, command)| AppTarget {
                id: id.to_string(),
                label: label.to_string(),
                kind: "command".to_string(),
                app_name: None,
                command: Some(command.to_string()),
            })
            .collect();
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "File Manager".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }
}

/// Open a project directory in an external app (editor / terminal / file manager). Blocking.
pub fn open_in_app(
    path: &str,
    app_name: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("Missing path".to_string());
    }

    if let Some(command) = command.map(str::trim).filter(|command| !command.is_empty()) {
        let mut launcher = Command::new(command);
        crate::windows_child::hide_console(&mut launcher);
        let status = launcher
            .arg(trimmed_path)
            .status()
            .map_err(|error| format!("Failed to launch `{command}`: {error}"))?;
        if !status.success() {
            return Err(format!("`{command}` exited with status {status}"));
        }
        return Ok(());
    }

    if let Some(app_name) = app_name
        .map(str::trim)
        .filter(|app_name| !app_name.is_empty())
    {
        #[cfg(target_os = "macos")]
        let status = Command::new("open")
            .arg("-a")
            .arg(app_name)
            .arg(trimmed_path)
            .status();
        #[cfg(not(target_os = "macos"))]
        let status = {
            let mut launcher = Command::new(app_name);
            crate::windows_child::hide_console(&mut launcher);
            launcher.arg(trimmed_path).status()
        };

        let status = status.map_err(|error| format!("Failed to open `{app_name}`: {error}"))?;
        if !status.success() {
            return Err(format!("`{app_name}` failed to open (status {status})"));
        }
        return Ok(());
    }

    open_path(trimmed_path)
}

fn open_path(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(path).status();
    #[cfg(target_os = "windows")]
    let status = {
        let mut command = Command::new("explorer");
        crate::windows_child::hide_console(&mut command);
        command.arg(path).status()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(path).status();

    match status.map_err(|error| format!("Failed to reveal path: {error}"))? {
        code if code.success() => Ok(()),
        code => Err(format!("File manager exited with status {code}")),
    }
}

/// Locate the settings.json file for a given scope. Global is
/// `~/.pi/agent/settings.json`; project is `<cwd>/.pi/settings.json`.
pub fn settings_path(scope: &str, cwd: &str) -> Result<PathBuf, String> {
    if scope == "project" {
        let cwd = cwd.trim_end_matches('/');
        let cwd = Path::new(cwd);
        let path = cwd.join(".pi").join("settings.json");
        if !cwd.is_dir() {
            return Err(format!("Workspace directory does not exist: {cwd:?}"));
        }
        Ok(path)
    } else {
        let agent_dir = dirs::home_dir()
            .ok_or_else(|| "Could not resolve home directory".to_string())?
            .join(".pi")
            .join("agent");
        Ok(agent_dir.join("settings.json"))
    }
}

/// Read the `packages` array (as JSON values) from a settings file, creating
/// an empty array when the file does not exist or has no `packages` key.
fn read_packages(
    path: &Path,
) -> Result<
    (
        serde_json::Map<String, serde_json::Value>,
        Vec<serde_json::Value>,
    ),
    String,
> {
    let root: serde_json::Map<String, serde_json::Value> = if path.exists() {
        serde_json::from_str(
            &std::fs::read_to_string(path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?,
        )
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?
    } else {
        serde_json::Map::new()
    };
    let packages = root
        .get("packages")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok((root, packages))
}

fn write_settings(
    path: &Path,
    root: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(root)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    let mut json = json;
    json.push('\n');
    std::fs::write(path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Extract the package `source` from either a string entry or an object entry
/// (with a `source` key).
fn entry_source(entry: &serde_json::Value) -> Option<String> {
    match entry {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(obj) => obj
            .get("source")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

/// A resource reference is an empty-able set of filters. Disabling a package
/// means rewriting its entry to the object form with all four resource arrays
/// empty (mirrors what `pi config` produces for a disabled package).
fn resourced_entry(source: &str) -> serde_json::Value {
    serde_json::json!({
        "source": source,
        "extensions": [],
        "skills": [],
        "prompts": [],
        "themes": []
    })
}

fn is_disabled_entry(entry: &serde_json::Value) -> bool {
    let serde_json::Value::Object(obj) = entry else {
        return false;
    };
    ["extensions", "skills", "prompts", "themes"]
        .iter()
        .all(|key| {
            obj.get(*key)
                .and_then(serde_json::Value::as_array)
                .map(|v| v.is_empty())
                .unwrap_or(false)
        })
}

/// Set a configured package's disabled state by editing the `packages` array
/// in the settings file for the given scope. Returns true when a change was made.
pub fn set_package_disabled(
    scope: &str,
    cwd: &str,
    source: &str,
    disabled: bool,
) -> Result<bool, String> {
    let path = settings_path(scope, cwd)?;
    let (mut root, packages) = read_packages(&path)?;
    let source = source.trim();
    let index = packages
        .iter()
        .position(|entry| entry_source(entry).as_deref() == Some(source));
    let Some(index) = index else {
        return Err(format!("Package not configured: {source}"));
    };
    if packages[index] == serde_json::Value::String(source.to_string()) && !disabled {
        // Already enabled as a plain string — no change needed.
        return Ok(false);
    }
    let mut next = packages;
    if disabled {
        next[index] = resourced_entry(source);
    } else if is_disabled_entry(&next[index]) {
        next[index] = serde_json::Value::String(source.to_string());
    } else {
        // Object form with filters — treat as already enabled.
        return Ok(false);
    }
    root.insert("packages".to_string(), serde_json::Value::Array(next));
    write_settings(&path, &root)?;
    Ok(true)
}

pub struct PackageMetadata {
    pub name: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
}

/// Read package.json metadata from an installed package path.
pub fn read_package_metadata(installed_path: &str) -> PackageMetadata {
    let path = Path::new(installed_path);
    let package_json = if path.is_dir() {
        path.join("package.json")
    } else {
        path.parent().unwrap_or(path).join("package.json")
    };
    let empty = || PackageMetadata {
        name: None,
        version: None,
        description: None,
    };
    let Ok(contents) = std::fs::read_to_string(&package_json) else {
        return empty();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return empty();
    };
    let name = parsed
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let version = parsed
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let description = parsed
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    PackageMetadata {
        name,
        version,
        description,
    }
}

fn resource_name(relative_path: &str) -> String {
    Path::new(relative_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(relative_path)
        .to_string()
}

fn dir_file_resources(
    dir: &Path,
    dir_name: &str,
    kind: &str,
    extensions: &[&str],
) -> Vec<ResourceEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut resources: Vec<ResourceEntry> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str())?;
            if !extensions.contains(&ext) {
                return None;
            }
            let file_name = path.file_name()?.to_str()?.to_string();
            Some(ResourceEntry {
                kind: kind.to_string(),
                name: resource_name(&file_name),
                relative_path: format!("{dir_name}/{file_name}"),
            })
        })
        .collect();
    resources.sort_by(|a, b| a.name.cmp(&b.name));
    resources
}

fn skill_resources(skills_dir: &Path) -> Vec<ResourceEntry> {
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return Vec::new();
    };
    let mut resources = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").is_file() {
            let Some(dir_name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            resources.push(ResourceEntry {
                kind: "skill".to_string(),
                name: dir_name.to_string(),
                relative_path: format!("skills/{dir_name}/SKILL.md"),
            });
        } else if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            resources.push(ResourceEntry {
                kind: "skill".to_string(),
                name: resource_name(file_name),
                relative_path: format!("skills/{file_name}"),
            });
        }
    }
    resources.sort_by(|a, b| a.name.cmp(&b.name));
    resources
}

/// Resolve the individual extensions/skills/prompts/themes a package
/// contributes, used for the management detail view. Reads the package `pi`
/// manifest when present, or falls back to conventional directories.
pub fn read_package_resources(installed_path: &str) -> Vec<ResourceEntry> {
    let path = Path::new(installed_path);
    let root = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };

    // Prefer the `pi` manifest arrays — each entry is a relative path string.
    if let Ok(contents) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) {
            if let Some(manifest) = parsed.get("pi").and_then(serde_json::Value::as_object) {
                let entries_from = |key: &str, kind: &str| -> Vec<ResourceEntry> {
                    manifest
                        .get(key)
                        .and_then(serde_json::Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(serde_json::Value::as_str)
                                .map(|value| ResourceEntry {
                                    kind: kind.to_string(),
                                    name: resource_name(value),
                                    relative_path: value.to_string(),
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let mut resources = Vec::new();
                resources.extend(entries_from("extensions", "extension"));
                resources.extend(entries_from("skills", "skill"));
                resources.extend(entries_from("prompts", "prompt"));
                resources.extend(entries_from("themes", "theme"));
                if !resources.is_empty() {
                    return resources;
                }
            }
        }
    }

    // Fall back to conventional directories.
    let mut resources = Vec::new();
    resources.extend(dir_file_resources(
        &root.join("extensions"),
        "extensions",
        "extension",
        &["ts", "js"],
    ));
    resources.extend(skill_resources(&root.join("skills")));
    resources.extend(dir_file_resources(
        &root.join("prompts"),
        "prompts",
        "prompt",
        &["md"],
    ));
    resources.extend(dir_file_resources(
        &root.join("themes"),
        "themes",
        "theme",
        &["json"],
    ));
    resources
}

/// Open a URL in the user's default browser via the OS opener. Blocking.
pub fn open_external(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Missing URL".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(trimmed).status();
    #[cfg(target_os = "windows")]
    let status = {
        let mut command = Command::new("cmd");
        crate::windows_child::hide_console(&mut command);
        command.args(["/C", "start", "", trimmed]).status()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(trimmed).status();

    match status.map_err(|error| format!("Failed to open URL: {error}"))? {
        code if code.success() => Ok(()),
        code => Err(format!("Opener exited with status {code}")),
    }
}

fn pi_extension_npm_bin_dir(home: &Path) -> PathBuf {
    home.join(".pi")
        .join("agent")
        .join("npm")
        .join("node_modules")
        .join(".bin")
}

fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::strip_verbatim_prefix;

    // Windows `std::fs::canonicalize` returns `\\?\`-prefixed extended-length
    // paths. Bun (the embedded pi runtime) cannot resolve modules from such
    // paths, so the prefix must be stripped before any canonicalized path
    // reaches pi — as cwd, session path, binary, or extension argument.
    #[test]
    fn strip_verbatim_prefix_removes_extended_length_prefix() {
        // Drive-prefixed extended-length path: strip the `\\?\` prefix,
        // keep the drive letter.
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\WIN10\.pi\agent"),
            r"C:\Users\WIN10\.pi\agent"
        );
        // UNC extended-length path: collapse `\\?\UNC\` to the plain `\\`
        // UNC form.
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\dir"),
            r"\\server\share\dir"
        );
        // Plain Windows path: returned unchanged.
        assert_eq!(strip_verbatim_prefix(r"C:\Users\WIN10"), r"C:\Users\WIN10");
        // Plain POSIX path: returned unchanged (no prefix to strip).
        assert_eq!(
            strip_verbatim_prefix("/home/user/.pi/agent"),
            "/home/user/.pi/agent"
        );
        // Empty string is a valid no-op input.
        assert_eq!(strip_verbatim_prefix(""), "");
    }
}
