use crate::native_pi_manager::NativeLaunchSpec;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

const PI_VERSION_JSON: &str = include_str!("../../scripts/pi-version.json");

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
        let mut candidates = Vec::new();
        if let Some(resources) = self.static_dir.parent() {
            candidates.push(resources.join("extensions").join("picot-bridge.mjs"));
        }
        if cfg!(debug_assertions) {
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("dist")
                    .join("picot-bridge.mjs"),
            );
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("picot-bridge.ts"),
            );
        }
        let bridge = candidates
            .iter()
            .find(|candidate| candidate.is_file())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Could not find picot-bridge extension. Tried:\n{}",
                    candidates
                        .iter()
                        .map(|path| format!("  - {}", path.display()))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            })?;
        Ok(NativeLaunchSpec {
            binary,
            cwd: PathBuf::from(strip_verbatim_prefix(cwd)),
            session_path: session_path.map(|path| PathBuf::from(strip_verbatim_prefix(path))),
            extensions: vec![PathBuf::from(sanitize_extension_path_for_pi(
                &strip_verbatim_prefix(&bridge.to_string_lossy()),
            ))],
            pi_version: locked_pi_version().to_owned(),
            path_env: build_augmented_path(),
        })
    }

    /// Run the embedded `pi` CLI with the given arguments and return trimmed stdout.
    /// Blocking; callers on an async runtime should wrap this in `spawn_blocking`.
    pub fn run_pi_command(&self, args: &[&str]) -> Result<String, String> {
        let pi_bin = self.resolve_bundled_pi()?;
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let augmented_path = build_augmented_path();
        let mut command = Command::new(&pi_bin_str);
        configure_child_process_for_windows(&mut command);
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

    /// Parse `pi list` output into the set of configured package sources
    /// (e.g. `npm:pi-web-access`, `git:…`, or local paths).
    pub fn list_pi_packages(&self) -> Result<Vec<String>, String> {
        let output = self.run_pi_command(&["list"])?;
        let mut sources = Vec::new();
        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("No packages installed.") {
                continue;
            }
            // Section headers such as "User packages:" end with a colon.
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
            if trimmed.starts_with("npm:") || trimmed.starts_with("git:") {
                sources.push(trimmed.to_string());
            }
            // Resolved install paths (indented under each source) are ignored:
            // they never match a registry package's `npm:<name>` source.
        }
        Ok(sources)
    }

    pub fn install_pi_package(&self, source: &str) -> Result<(), String> {
        self.run_pi_command(&["install", source]).map(|_| ())
    }

    pub fn remove_pi_package(&self, source: &str) -> Result<(), String> {
        self.run_pi_command(&["remove", source]).map(|_| ())
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
        let status = Command::new(command)
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
        let status = Command::new(app_name).arg(trimmed_path).status();

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
        configure_child_process_for_windows(&mut command);
        command.arg(path).status()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(path).status();

    match status.map_err(|error| format!("Failed to reveal path: {error}"))? {
        code if code.success() => Ok(()),
        code => Err(format!("File manager exited with status {code}")),
    }
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
        configure_child_process_for_windows(&mut command);
        command.args(["/C", "start", "", trimmed]).status()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(trimmed).status();

    match status.map_err(|error| format!("Failed to open URL: {error}"))? {
        code if code.success() => Ok(()),
        code => Err(format!("Opener exited with status {code}")),
    }
}

#[cfg(target_os = "windows")]
fn configure_child_process_for_windows(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: keep console-less GUI children from flashing a window.
    command.creation_flags(0x0800_0000);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_process_for_windows(_command: &mut Command) {}

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
        Ok(mirrored) => mirrored.to_string_lossy().to_string(),
        Err(error) => {
            log::warn!(
                "[picot-native] failed to mirror extension to a space-free path ({error}); using original"
            );
            original.to_string()
        }
    }
}

#[cfg(target_os = "windows")]
fn mirror_to_space_free_dir(src: &Path) -> std::io::Result<PathBuf> {
    let file_name = src.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "extension path has no file name",
        )
    })?;
    let mut dest_dir = std::env::temp_dir();
    if dest_dir.to_string_lossy().contains(' ') {
        dest_dir = PathBuf::from("C:\\ProgramData\\picot");
    }
    dest_dir.push("picot-ext");
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(file_name);
    std::fs::copy(src, &dest)?;
    Ok(dest)
}
