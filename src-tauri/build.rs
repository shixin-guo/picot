use std::path::PathBuf;

/// Hard guarantee: a Pi Studio release build CANNOT be produced without the
/// embedded pi binary inside `src-tauri/resources/pi/`.
///
/// Why this lives in build.rs
/// --------------------------
/// `tauri.conf.json` already lists `./resources/pi` under `bundle.resources`,
/// and the package scripts run `fetch:pi` as a `prebuild` / `beforeBuildCommand`
/// hook. But it is still possible to run `cargo build --release` directly
/// (CI matrix shortcuts, IDE "build" buttons, manual debugging of bundling)
/// without ever going through bun. When that happens the .app is silently
/// produced WITHOUT a pi binary and end users hit the runtime "Could not
/// find embedded pi binary" screen — exactly what we are trying to prevent.
///
/// This build script makes that failure mode impossible: in any non-debug
/// cargo build we panic at compile time if the binary is missing, with a
/// clear message pointing the developer at `bun run fetch:pi`. Debug builds
/// keep working without the binary so `cargo check` / `clippy` / IDE flows
/// don't require a network round-trip.
fn main() {
    tauri_build::build();

    // Re-run if the version pin or the binary itself changes, so cached
    // builds notice when fetch:pi has been run between invocations.
    println!("cargo:rerun-if-changed=resources/pi/.version");
    println!("cargo:rerun-if-changed=../scripts/pi-version.json");
    println!("cargo:rerun-if-env-changed=PI_STUDIO_SKIP_BIN_CHECK");

    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile != "release" {
        return;
    }

    if std::env::var("PI_STUDIO_SKIP_BIN_CHECK").is_ok() {
        return;
    }

    let bin_name = if cfg!(target_os = "windows") {
        "pi.exe"
    } else {
        "pi"
    };

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let bin_path = manifest_dir.join("resources").join("pi").join(bin_name);

    if !bin_path.is_file() {
        panic!(
            "\n\n\
             Pi Studio release build aborted: embedded pi binary is missing.\n\
             Expected: {}\n\n\
             Pi Studio bundles the pi runtime inside the .app so end users do\n\
             not need to fetch anything. Release builds therefore refuse to\n\
             produce a .app without it.\n\n\
             Fix: run `bun run fetch:pi` from the repo root before building.\n\
             (Or `bun run build`, which already does this for you.)\n\n\
             To bypass this check (NOT for shipping builds), set\n\
             PI_STUDIO_SKIP_BIN_CHECK=1.\n\n",
            bin_path.display()
        );
    }
}
