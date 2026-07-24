use super::strip_verbatim_prefix;
use std::path::{Path, PathBuf};

pub(super) fn resolve_bundled_extensions(
    static_dir: &Path,
    cwd: &Path,
    is_saved_session: bool,
) -> Result<Vec<PathBuf>, String> {
    bundled_extension_names_for_launch(cwd, is_saved_session)
        .into_iter()
        .map(|name| resolve_bundled_extension(static_dir, name))
        .collect()
}

fn bundled_extension_names_for_launch(cwd: &Path, is_saved_session: bool) -> Vec<&'static str> {
    let normalized = cwd.to_string_lossy().replace('\\', "/");
    let is_agent_inbox = normalized
        .trim_end_matches('/')
        .ends_with("/.pi/agent/super-agent");
    if is_agent_inbox && is_saved_session {
        vec!["picot-bridge.mjs", "pi-chat.mjs"]
    } else {
        vec!["picot-bridge.mjs"]
    }
}

fn resolve_bundled_extension(static_dir: &Path, extension_name: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(resources) = static_dir.parent() {
        candidates.push(resources.join("extensions").join(extension_name));
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("extensions")
                .join("dist")
                .join(extension_name),
        );
        if extension_name == "picot-bridge.mjs" {
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("picot-bridge.ts"),
            );
        } else if extension_name == "pi-chat.mjs" {
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("pi-chat-src")
                    .join("extension-entry.ts"),
            );
        }
    }
    let extension = candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
        .ok_or_else(|| {
            format!(
                "Could not find {extension_name} extension. Tried:\n{}",
                candidates
                    .iter()
                    .map(|path| format!("  - {}", path.display()))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        })?;
    Ok(PathBuf::from(sanitize_extension_path_for_pi(
        &strip_verbatim_prefix(&extension.to_string_lossy()),
    )))
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

#[cfg(test)]
mod tests {
    use super::bundled_extension_names_for_launch;
    use std::path::Path;

    #[test]
    fn saved_agent_inbox_session_loads_the_bundled_telegram_listener() {
        assert_eq!(
            bundled_extension_names_for_launch(Path::new("/Users/me/.pi/agent/super-agent"), true,),
            vec!["picot-bridge.mjs", "pi-chat.mjs"]
        );
    }

    #[test]
    fn regular_projects_do_not_compete_for_the_telegram_listener() {
        assert_eq!(
            bundled_extension_names_for_launch(Path::new("/Users/me/code/project"), true),
            vec!["picot-bridge.mjs"]
        );
    }

    #[test]
    fn temporary_agent_inbox_runtime_does_not_steal_the_telegram_listener() {
        assert_eq!(
            bundled_extension_names_for_launch(Path::new("/Users/me/.pi/agent/super-agent"), false,),
            vec!["picot-bridge.mjs"]
        );
    }
}
