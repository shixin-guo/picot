use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{OnceCell, Semaphore};

pub const INPUT_BYTE_CAP: u64 = 32 * 1024 * 1024;
const OUTPUT_BYTE_CAP: usize = 2 * 1024 * 1024;
const STDERR_BYTE_CAP: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONCURRENCY: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyReason {
    PythonMissing,
    PythonTooOld { version: String },
    MarkitdownMissing,
    MarkitdownIncompatible,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversionOutcome {
    Ready(String),
    DependencyUnavailable {
        reason: DependencyReason,
        display_command: Option<String>,
    },
    Failed,
}

#[derive(Debug, Clone)]
enum DependencyProbe {
    Available {
        executable: String,
    },
    Unavailable {
        reason: DependencyReason,
        display_command: Option<String>,
    },
}

#[derive(Clone)]
pub struct MarkitdownPreviewService {
    probe: Arc<OnceCell<DependencyProbe>>,
    permits: Arc<Semaphore>,
}

impl Default for MarkitdownPreviewService {
    fn default() -> Self {
        Self {
            probe: Arc::new(OnceCell::new()),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENCY)),
        }
    }
}

impl MarkitdownPreviewService {
    pub async fn convert(&self, suffix: &str, input: Vec<u8>) -> ConversionOutcome {
        if input.len() as u64 > INPUT_BYTE_CAP || !is_convertible_suffix(suffix) {
            return ConversionOutcome::Failed;
        }
        let dependency = self.probe.get_or_init(probe_dependency).await.clone();
        let DependencyProbe::Available { executable } = dependency else {
            let DependencyProbe::Unavailable {
                reason,
                display_command,
            } = dependency
            else {
                unreachable!()
            };
            return ConversionOutcome::DependencyUnavailable {
                reason,
                display_command,
            };
        };
        let Ok(_permit) = self.permits.clone().try_acquire_owned() else {
            return ConversionOutcome::Failed;
        };
        let args = ["-m", "markitdown", "-x", &format!(".{suffix}")];
        match run_bounded(&executable, &args, Some(input), false).await {
            Some((status, stdout, _)) if status && !stdout.trim().is_empty() => {
                ConversionOutcome::Ready(stdout)
            }
            _ => ConversionOutcome::Failed,
        }
    }
}

pub fn is_convertible_suffix(suffix: &str) -> bool {
    matches!(
        suffix,
        "doc"
            | "docx"
            | "rtf"
            | "odt"
            | "ppt"
            | "pptx"
            | "odp"
            | "xls"
            | "xlsx"
            | "ods"
            | "eml"
            | "msg"
    )
}

async fn probe_dependency() -> DependencyProbe {
    const VERSION_SCRIPT: &str =
        "import sys; print(sys.version_info[0], sys.version_info[1], sys.version_info[2]); print(sys.executable)";
    const CAPABILITY_SCRIPT: &str = "from markitdown import MarkItDown, StreamInfo; print('ok')";
    let candidates: Vec<(&str, Vec<&str>, &str)> = if cfg!(windows) {
        vec![
            ("py", vec!["-3"], "py -3"),
            ("python.exe", vec![], "python.exe"),
        ]
    } else {
        vec![("python3", vec![], "python3"), ("python", vec![], "python")]
    };
    let mut old: Option<(String, String)> = None;
    let mut missing: Option<String> = None;
    let mut incompatible: Option<String> = None;
    for (command, launcher, display) in candidates {
        let mut version_args = launcher.clone();
        version_args.extend(["-c", VERSION_SCRIPT]);
        let Some((true, stdout, _)) = run_bounded(command, &version_args, None, true).await else {
            continue;
        };
        let mut lines = stdout.lines();
        let Some(version) = parse_version(lines.next().unwrap_or_default()) else {
            continue;
        };
        if version.0 < 3 || (version.0 == 3 && version.1 < 10) {
            old.get_or_insert((version.3, display.to_owned()));
            continue;
        }
        let executable = lines.next().unwrap_or_default().trim().to_owned();
        if executable.is_empty() || !std::path::Path::new(&executable).is_absolute() {
            incompatible.get_or_insert(display.to_owned());
            continue;
        }
        let capability = run_bounded(&executable, &["-c", CAPABILITY_SCRIPT], None, false).await;
        let Some((true, _, stderr)) = capability else {
            let result = capability;
            if result
                .as_ref()
                .is_some_and(|(_, out, err)| format!("{out}{err}").contains("No module named"))
            {
                missing.get_or_insert(display.to_owned());
            } else {
                incompatible.get_or_insert(display.to_owned());
            }
            continue;
        };
        if !stderr.is_empty() {
            log::debug!("[markitdown] capability probe emitted diagnostics");
        }
        let Some((true, help, _)) =
            run_bounded(&executable, &["-m", "markitdown", "--help"], None, false).await
        else {
            incompatible.get_or_insert(display.to_owned());
            continue;
        };
        if !help.contains("--extension") && !help.contains("-x") {
            incompatible.get_or_insert(display.to_owned());
            continue;
        }
        return DependencyProbe::Available { executable };
    }
    if let Some(display_command) = missing {
        DependencyProbe::Unavailable {
            reason: DependencyReason::MarkitdownMissing,
            display_command: Some(display_command),
        }
    } else if let Some(display_command) = incompatible {
        DependencyProbe::Unavailable {
            reason: DependencyReason::MarkitdownIncompatible,
            display_command: Some(display_command),
        }
    } else if let Some((version, display_command)) = old {
        DependencyProbe::Unavailable {
            reason: DependencyReason::PythonTooOld { version },
            display_command: Some(display_command),
        }
    } else {
        DependencyProbe::Unavailable {
            reason: DependencyReason::PythonMissing,
            display_command: None,
        }
    }
}

fn parse_version(value: &str) -> Option<(u32, u32, u32, String)> {
    let parts: Vec<_> = value.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }
    let major = parts[0].parse().ok()?;
    let minor = parts[1].parse().ok()?;
    let patch = parts[2].parse().ok()?;
    Some((major, minor, patch, format!("{major}.{minor}.{patch}")))
}

fn child_environment(include_path: bool) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in [
        "LANG",
        "LC_ALL",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "ComSpec",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_owned(), value);
        }
    }
    if include_path {
        if let Ok(value) = std::env::var("PATH") {
            env.insert("PATH".into(), value.chars().take(4096).collect());
        }
    }
    env
}

async fn read_capped<R: AsyncRead + Unpin>(mut reader: R, cap: usize) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let count = reader.read(&mut chunk).await.ok()?;
        if count == 0 {
            return Some(output);
        }
        if output.len() + count > cap {
            return None;
        }
        output.extend_from_slice(&chunk[..count]);
    }
}

async fn run_bounded(
    executable: &str,
    args: &[&str],
    input: Option<Vec<u8>>,
    include_path: bool,
) -> Option<(bool, String, String)> {
    let mut command = Command::new(executable);
    crate::windows_child::hide_console_tokio(&mut command);
    command
        .args(args)
        .env_clear()
        .envs(child_environment(include_path))
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;
    let mut stdin = child.stdin.take();
    let writer = tokio::spawn(async move {
        if let (Some(bytes), Some(mut stdin)) = (input, stdin.take()) {
            stdin.write_all(&bytes).await?;
            stdin.shutdown().await?;
        }
        Ok::<(), std::io::Error>(())
    });
    let stdout_reader = tokio::spawn(read_capped(stdout, OUTPUT_BYTE_CAP));
    let stderr_reader = tokio::spawn(read_capped(stderr, STDERR_BYTE_CAP));
    let completed = tokio::time::timeout(TIMEOUT, async {
        let status = child.wait().await.ok()?;
        writer.await.ok()?.ok()?;
        let stdout = stdout_reader.await.ok()??;
        let stderr = stderr_reader.await.ok()??;
        Some((status.success(), stdout, stderr))
    })
    .await
    .ok()??;
    Some((
        completed.0,
        String::from_utf8_lossy(&completed.1).into_owned(),
        String::from_utf8_lossy(&completed.2).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{is_convertible_suffix, parse_version};

    #[test]
    fn recognizes_only_the_document_preview_allowlist() {
        for suffix in ["docx", "pptx", "xlsx", "eml", "msg", "rtf"] {
            assert!(is_convertible_suffix(suffix));
        }
        for suffix in ["csv", "mbox", "pdf", "sh"] {
            assert!(!is_convertible_suffix(suffix));
        }
    }

    #[test]
    fn parses_python_version_without_exposing_other_output() {
        assert_eq!(
            parse_version("3 10 12"),
            Some((3, 10, 12, "3.10.12".into()))
        );
        assert_eq!(parse_version("Python 3.10"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_runner_streams_stdin_and_rejects_oversized_stdout() {
        let result = super::run_bounded("/bin/cat", &[], Some(b"hello".to_vec()), false)
            .await
            .unwrap();
        assert!(result.0);
        assert_eq!(result.1, "hello");

        let oversized = vec![b'x'; super::OUTPUT_BYTE_CAP + 1];
        assert!(super::run_bounded("/bin/cat", &[], Some(oversized), false)
            .await
            .is_none());
    }
}
