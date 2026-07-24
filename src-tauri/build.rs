use std::{fs, path::PathBuf};

/// Hard guarantee: a Picot release build CANNOT be produced without the
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
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let extension_dist_dir = manifest_dir.join("..").join("extensions").join("dist");

    // Tauri validates every configured bundle resource while running the build
    // script, even for debug `cargo check` / clippy flows. The extension bundle
    // is generated, so a clean checkout may not have this directory yet.
    fs::create_dir_all(&extension_dist_dir).unwrap_or_else(|err| {
        panic!(
            "failed to create generated extension resource directory at {}: {}",
            extension_dist_dir.display(),
            err
        )
    });

    tauri_build::build();

    // Expose the locked pi version as a compile-time env var so Rust code can
    // reference it via env!("PI_STUDIO_PI_VERSION_BUNDLED") instead of
    // duplicating the literal string across multiple files.
    let pi_version_json = manifest_dir
        .join("..")
        .join("scripts")
        .join("pi-version.json");
    if let Ok(contents) = fs::read_to_string(&pi_version_json) {
        // Minimal parse: extract the "version" field without pulling in serde.
        if let Some(version) = contents
            .lines()
            .find(|l| l.contains("\"version\""))
            .and_then(|l| l.split('"').nth(3))
        {
            println!("cargo:rustc-env=PI_STUDIO_PI_VERSION_BUNDLED={version}");
        }
    }

    // Re-run if the version pin or the binary itself changes, so cached
    // builds notice when fetch:pi has been run between invocations.
    println!("cargo:rerun-if-changed=resources/pi/.version");
    println!("cargo:rerun-if-changed=../scripts/pi-version.json");
    println!("cargo:rerun-if-changed=../extensions/picot-bridge.ts");
    println!("cargo:rerun-if-changed=../extensions/dist/picot-bridge.mjs");
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

    let bin_path = manifest_dir.join("resources").join("pi").join(bin_name);
    let extension_bundle_path = extension_dist_dir.join("picot-bridge.mjs");

    if !bin_path.is_file() {
        panic!(
            "\n\n\
             Picot release build aborted: embedded pi binary is missing.\n\
             Expected: {}\n\n\
             Picot bundles the pi runtime inside the .app so end users do\n\
             not need to fetch anything. Release builds therefore refuse to\n\
             produce a .app without it.\n\n\
             Fix: run `bun run fetch:pi` from the repo root before building.\n\
             (Or `bun run build`, which already does this for you.)\n\n\
             To bypass this check (NOT for shipping builds), set\n\
             PI_STUDIO_SKIP_BIN_CHECK=1.\n\n",
            bin_path.display()
        );
    }

    if !extension_bundle_path.is_file() {
        panic!(
            "\n\n\
             Picot release build aborted: picot-bridge extension bundle is missing.\n\
             Expected: {}\n\n\
             Release builds ship the bundled extension instead of relying on\n\
             repo-local TypeScript sources or node_modules.\n\n\
             Fix: run `bun run build:extensions` from the repo root before building.\n\
             (Or `bun run build`, which already does this for you.)\n\n\
             To bypass this check (NOT for shipping builds), set\n\
             PI_STUDIO_SKIP_BIN_CHECK=1.\n\n",
            extension_bundle_path.display()
        );
    }
}
