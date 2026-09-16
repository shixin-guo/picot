//! Suppress console windows for spawned children on Windows.
//!
//! Picot's release build is a GUI-subsystem binary (no console of its own).
//! Windows gives every console child we spawn (git, node, npm, python, cmd)
//! a brand-new, visible console window unless the `CREATE_NO_WINDOW` flag is
//! passed to that one `CreateProcess` call — the flag is per-spawn and is not
//! inherited by grandchildren. Those windows live exactly as long as the
//! child runs, which is the "several terminal windows flashing randomly"
//! reported in issue #39.
//!
//! Route every spawn through [`hide_console`] / [`hide_console_tokio`] the way
//! spawns are routed through `appimage_env::scrub`, so the flag cannot be
//! forgotten at a new call site.

use std::process::Command as StdCommand;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hide the child's console window on Windows; no-op on other platforms.
pub fn hide_console(command: &mut StdCommand) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// tokio counterpart of [`hide_console`].
pub fn hide_console_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        // tokio::process::Command exposes creation_flags natively on Windows.
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}
