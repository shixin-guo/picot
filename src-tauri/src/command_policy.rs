// ABOUTME: Classifies Picot core RPC commands against the shared JSON manifest.
// ABOUTME: Used by the broker to enforce ephemeral command authorization.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EphemeralPermission {
    Allowed,
    DeniedSessionLifecycle,
    DesktopOwnerOnly,
}

#[derive(Deserialize)]
struct Manifest {
    version: u32,
    commands: HashMap<String, String>,
}

struct ParsedManifest {
    commands: HashMap<String, EphemeralPermission>,
}

static MANIFEST: OnceLock<ParsedManifest> = OnceLock::new();

fn manifest() -> &'static ParsedManifest {
    MANIFEST.get_or_init(|| {
        let raw = include_str!("../../protocol/picot-core-commands.json");
        let manifest: Manifest =
            serde_json::from_str(raw).expect("picot-core-commands.json must be valid");
        assert_eq!(
            manifest.version, 1,
            "picot-core-commands manifest version must be 1"
        );
        let mut commands = HashMap::new();
        for (name, value) in manifest.commands {
            let permission = match value.as_str() {
                "allowed" => EphemeralPermission::Allowed,
                "deniedSessionLifecycle" => EphemeralPermission::DeniedSessionLifecycle,
                "desktopOwnerOnly" => EphemeralPermission::DesktopOwnerOnly,
                other => panic!("unknown permission {other:?} for command {name:?}"),
            };
            commands.insert(name, permission);
        }
        ParsedManifest { commands }
    })
}

pub fn classify_core_command(command: &str) -> Option<EphemeralPermission> {
    manifest().commands.get(command).copied()
}

pub fn authorize_ephemeral_command(
    command: &str,
    authenticated_desktop_owner: bool,
) -> Result<(), &'static str> {
    match classify_core_command(command) {
        None | Some(EphemeralPermission::DeniedSessionLifecycle) => {
            Err("Command is not available in temporary chat")
        }
        Some(EphemeralPermission::Allowed) => Ok(()),
        Some(EphemeralPermission::DesktopOwnerOnly) => {
            if authenticated_desktop_owner {
                Ok(())
            } else {
                Err("Command is not available in temporary chat")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_allowed_command() {
        assert_eq!(
            classify_core_command("prompt"),
            Some(EphemeralPermission::Allowed)
        );
    }

    #[test]
    fn classify_denied_session_lifecycle_command() {
        assert_eq!(
            classify_core_command("new_session"),
            Some(EphemeralPermission::DeniedSessionLifecycle)
        );
    }

    #[test]
    fn classify_desktop_owner_only_command() {
        assert_eq!(
            classify_core_command("set_api_key"),
            Some(EphemeralPermission::DesktopOwnerOnly)
        );
    }

    #[test]
    fn unknown_command_fails_closed() {
        assert_eq!(classify_core_command("does_not_exist"), None);
    }

    #[test]
    fn unknown_command_is_denied_for_ephemeral() {
        assert!(authorize_ephemeral_command("does_not_exist", true).is_err());
    }

    #[test]
    fn desktop_owner_only_requires_owner() {
        assert!(authorize_ephemeral_command("set_api_key", false).is_err());
        assert!(authorize_ephemeral_command("set_api_key", true).is_ok());
    }

    #[test]
    fn manifest_has_exact_parity_with_json_command_count() {
        let raw = include_str!("../../protocol/picot-core-commands.json");
        let manifest: Manifest = serde_json::from_str(raw).expect("manifest parses");
        assert_eq!(manifest.version, 1);
        // 25 handleCommand cases plus the two predeclared ephemeral commands.
        assert_eq!(manifest.commands.len(), 27);
    }
}
