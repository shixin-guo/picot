#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// How to spawn one external Agent Client Protocol (ACP) coding agent — the
/// same shape `NativeLaunchSpec` plays for the embedded Pi runtime, but for a
/// subprocess that speaks ACP JSON-RPC over stdio instead of Pi's flat framing.
#[derive(Debug, Clone)]
pub struct AcpLaunchSpec {
    /// Stable id used in `RuntimeTarget`-adjacent bookkeeping and by the
    /// composer's `#` picker, e.g. `"claude-code"`.
    pub agent_id: String,
    /// Human-readable name shown in the composer picker.
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

struct Preset {
    id: &'static str,
    label: &'static str,
    /// Default whitespace-separated command line — either a native `--acp` mode
    /// of the CLI or an `npx` invocation of an ACP adapter package.
    default_cmd: &'static str,
    /// The underlying CLI the agent needs. Presence of this binary on PATH is
    /// what "the agent is installed locally" means for the `#` picker.
    probe_bin: &'static str,
    /// If set, presence of this env var also counts as "available" (the agent
    /// can auth via an API key without its CLI logged in).
    api_key_env: Option<&'static str>,
}

/// Built-in ACP agent presets. Each `default_cmd` is overridable via
/// `PICOT_ACP_<ID>_CMD` (id upper-cased, `-` → `_`); the legacy
/// `PICOT_ACP_CLAUDE_CMD` still works for `claude-code`.
///
/// These are the agents the Agent Client Protocol ecosystem ships today:
/// Claude Code and Gemini CLI speak ACP natively; Codex and Cursor via a thin
/// `npx` adapter over their CLI. Qwen Code is a Gemini-CLI fork and inherits
/// its `--experimental-acp` flag.
const PRESETS: &[Preset] = &[
    Preset {
        id: "claude-code",
        label: "Claude Code",
        default_cmd: "npx -y @agentclientprotocol/claude-agent-acp",
        probe_bin: "claude",
        api_key_env: Some("ANTHROPIC_API_KEY"),
    },
    Preset {
        id: "gemini",
        label: "Gemini CLI",
        default_cmd: "npx -y @google/gemini-cli --experimental-acp",
        probe_bin: "gemini",
        api_key_env: Some("GEMINI_API_KEY"),
    },
    Preset {
        id: "codex",
        label: "Codex",
        default_cmd: "npx -y @agentclientprotocol/codex-acp",
        probe_bin: "codex",
        api_key_env: None,
    },
    Preset {
        id: "cursor",
        label: "Cursor",
        default_cmd: "npx -y cursor-agent-acp",
        probe_bin: "cursor-agent",
        api_key_env: None,
    },
    Preset {
        id: "qwen",
        label: "Qwen Code",
        default_cmd: "npx -y @qwen-code/qwen-code --experimental-acp",
        probe_bin: "qwen",
        api_key_env: None,
    },
];

fn env_key(agent_id: &str) -> String {
    format!(
        "PICOT_ACP_{}_CMD",
        agent_id.to_uppercase().replace('-', "_")
    )
}

fn cmd_override(agent_id: &str) -> Option<String> {
    std::env::var(env_key(agent_id)).ok().or_else(|| {
        // Back-compat: the first preset shipped with this name.
        if agent_id == "claude-code" {
            std::env::var("PICOT_ACP_CLAUDE_CMD").ok()
        } else {
            None
        }
    })
}

/// Resolve a built-in ACP agent preset, applying any `PICOT_ACP_*_CMD` override.
pub fn resolve_preset(agent_id: &str, cwd: PathBuf) -> Result<AcpLaunchSpec, String> {
    let preset = PRESETS
        .iter()
        .find(|preset| preset.id == agent_id)
        .ok_or_else(|| format!("Unknown ACP agent preset: {agent_id}"))?;

    let raw = cmd_override(agent_id).unwrap_or_else(|| preset.default_cmd.to_string());
    let mut parts = raw.split_whitespace();
    let command = parts
        .next()
        .ok_or_else(|| format!("{} is empty", env_key(agent_id)))?
        .to_string();
    let args = parts.map(str::to_string).collect();
    Ok(AcpLaunchSpec {
        agent_id: agent_id.to_string(),
        label: preset.label.to_string(),
        command,
        args,
        cwd,
    })
}

/// Every built-in preset, regardless of local availability.
pub fn available_presets() -> Vec<(&'static str, &'static str)> {
    PRESETS
        .iter()
        .map(|preset| (preset.id, preset.label))
        .collect()
}

/// Presets whose agent looks usable on this machine — the underlying CLI is on
/// PATH, or the user pinned a command via `PICOT_ACP_<ID>_CMD`, or (Claude only)
/// an `ANTHROPIC_API_KEY` is present. This is what the composer's `#` picker
/// shows so users aren't offered agents they can't run.
pub fn detected_presets(path_env: &str) -> Vec<(&'static str, &'static str)> {
    PRESETS
        .iter()
        .filter(|preset| preset_is_available(preset, path_env))
        .map(|preset| (preset.id, preset.label))
        .collect()
}

fn preset_is_available(preset: &Preset, path_env: &str) -> bool {
    if cmd_override(preset.id).is_some() {
        return true;
    }
    if preset
        .api_key_env
        .is_some_and(|key| std::env::var(key).is_ok())
    {
        return true;
    }
    binary_on_path(preset.probe_bin, path_env)
}

fn binary_on_path(bin: &str, path_env: &str) -> bool {
    for dir in std::env::split_paths(path_env) {
        if is_executable_file(&dir.join(bin)) {
            return true;
        }
        #[cfg(target_os = "windows")]
        for ext in ["exe", "cmd", "bat"] {
            if is_executable_file(&dir.join(format!("{bin}.{ext}"))) {
                return true;
            }
        }
    }
    false
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::{detected_presets, resolve_preset};
    use std::path::PathBuf;
    use std::sync::Mutex;

    // `resolve_preset` / `detected_presets` read process env; serialize the
    // env-touching tests so Rust's parallel runner can't interleave mutations.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn clear_overrides() {
        // SAFETY: test-only env mutation, single-threaded within each test.
        unsafe {
            for key in [
                "PICOT_ACP_CLAUDE_CMD",
                "PICOT_ACP_CLAUDE_CODE_CMD",
                "PICOT_ACP_CODEX_CMD",
                "PICOT_ACP_CURSOR_CMD",
                "PICOT_ACP_GEMINI_CMD",
                "PICOT_ACP_QWEN_CMD",
                "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY",
            ] {
                std::env::remove_var(key);
            }
        }
    }

    #[test]
    fn claude_code_preset_defaults_to_the_verified_npx_command() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_overrides();
        let spec = resolve_preset("claude-code", PathBuf::from("/workspace")).unwrap();
        assert_eq!(spec.command, "npx");
        assert_eq!(spec.args, vec!["-y", "@agentclientprotocol/claude-agent-acp"]);
        assert_eq!(spec.label, "Claude Code");
        assert_eq!(spec.cwd, PathBuf::from("/workspace"));
    }

    #[test]
    fn extra_presets_have_defaults() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_overrides();
        for (id, label, expected_args) in [
            ("gemini", "Gemini CLI", vec!["-y", "@google/gemini-cli", "--experimental-acp"]),
            ("codex", "Codex", vec!["-y", "@agentclientprotocol/codex-acp"]),
            ("cursor", "Cursor", vec!["-y", "cursor-agent-acp"]),
            ("qwen", "Qwen Code", vec!["-y", "@qwen-code/qwen-code", "--experimental-acp"]),
        ] {
            let spec = resolve_preset(id, PathBuf::from("/w")).unwrap();
            assert_eq!(spec.command, "npx", "{id}");
            assert_eq!(spec.args, expected_args, "{id}");
            assert_eq!(spec.label, label, "{id}");
        }
    }

    #[test]
    fn gemini_is_available_with_only_an_api_key() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_overrides();
        // SAFETY: test-only env mutation, single-threaded within this test.
        unsafe {
            std::env::set_var("GEMINI_API_KEY", "x");
        }
        let ids: Vec<_> = detected_presets("").into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec!["gemini"]);
        clear_overrides();
    }

    #[test]
    fn per_agent_env_override_wins() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_overrides();
        // SAFETY: test-only env mutation, single-threaded within this test.
        unsafe {
            std::env::set_var("PICOT_ACP_CODEX_CMD", "/opt/codex-acp --stdio");
        }
        let spec = resolve_preset("codex", PathBuf::from("/w")).unwrap();
        assert_eq!(spec.command, "/opt/codex-acp");
        assert_eq!(spec.args, vec!["--stdio"]);
        clear_overrides();
    }

    #[test]
    fn unknown_preset_is_rejected() {
        assert!(resolve_preset("aider", PathBuf::from("/workspace")).is_err());
    }

    #[test]
    fn detection_hides_agents_with_no_local_cli() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_overrides();
        // A PATH with none of the probe binaries -> nothing detected.
        let empty = std::env::temp_dir();
        let ids: Vec<_> = detected_presets(&empty.to_string_lossy())
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert!(ids.is_empty(), "expected no agents, got {ids:?}");
    }

    #[test]
    fn detection_includes_an_agent_with_a_pinned_command() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_overrides();
        // SAFETY: test-only env mutation, single-threaded within this test.
        unsafe {
            std::env::set_var("PICOT_ACP_CURSOR_CMD", "cursor-agent-acp");
        }
        let ids: Vec<_> = detected_presets("")
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(ids, vec!["cursor"]);
        clear_overrides();
    }
}
