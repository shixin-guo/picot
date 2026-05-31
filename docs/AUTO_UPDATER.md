# Pi Studio auto-updater

Pi Studio ships with the official Tauri v2 updater plugin
(`tauri-plugin-updater`). On every launch — and every 6 hours while the app
is open — it asks GitHub if a newer release is available and surfaces the
result in **Settings → General → Updates**. Users can also click
**Check now** at any time.

The updater talks to a static `latest.json` manifest published as part of
the GitHub release for the repo configured in `tauri.conf.json`:

```
https://github.com/shixin-guo/pi-web-ui/releases/latest/download/latest.json
```

`latest.json` lists, per platform/arch, the bundle URL plus a signature
that Tauri verifies against the public key baked into the app. The release
workflow (`.github/workflows/release.yml`) builds the platform installers,
signs them, and uploads both the installer and `latest.json` automatically
via `tauri-apps/tauri-action`.

## One-time setup (maintainer)

The auto-updater is **disabled** until a signing key pair exists. Without
it, `tauri build` will not emit `*.sig` files or `latest.json`, and the
plugin in the installed app will refuse to accept any update.

### 1. Generate the signing key pair

Run once on a trusted machine — keep the private key safe.

```bash
bun run tauri signer generate -- -w ~/.tauri/pi-studio.key
```

This prints the **public key** (a single base64 line) and writes the
**private key** to `~/.tauri/pi-studio.key`. You will also be prompted for
an optional password that encrypts the private key.

### 2. Embed the public key in the app

Open `src-tauri/tauri.conf.json` and paste the public key into
`plugins.updater.pubkey`:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu...",
      "endpoints": [
        "https://github.com/shixin-guo/pi-web-ui/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Commit this change. Every released build will validate updates against
this exact public key — rotating it later requires shipping a new app
version with the new public key, then re-signing future releases with the
new private key.

### 3. Add the private key to GitHub Actions secrets

Repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**:

| Name                                 | Value                                            |
| ------------------------------------ | ------------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | Full contents of `~/.tauri/pi-studio.key`        |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you chose (empty string if none)    |

The release workflow reads both as env vars when invoking
`tauri-action`.

### 4. Cut a release

```bash
bun run release 0.1.13
```

This bumps the version in all manifests, commits, tags `v0.1.13`, and
pushes. GitHub Actions builds installers for macOS / Linux / Windows,
signs each bundle, and uploads:

- `Pi Studio_0.1.13_aarch64.dmg` (etc.)
- `Pi Studio_0.1.13_aarch64.app.tar.gz` + `.sig` (macOS updater bundle)
- `pi-studio_0.1.13_amd64.AppImage` + `.sig` (Linux updater bundle)
- `Pi Studio_0.1.13_x64-setup.exe` + `.sig` (Windows NSIS updater)
- `latest.json` (manifest the updater fetches)

End users on older versions will see a **"Update available: 0.1.13"** row
in Settings on their next launch (or within ~6 hours of staying open).

## Verifying it works

1. Install the previous release locally.
2. Cut a new release with a strictly greater version.
3. Open Pi Studio → **Settings** → **General** → **Updates** →
   **Check now**. You should see *Update available: 0.1.13*.
4. Click **Download & install**. The app downloads, installs, and
   relaunches into the new version.

## How it's wired

| Layer          | File                                        | Role                                                                 |
| -------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Rust runtime   | `src-tauri/Cargo.toml`                      | Pulls in `tauri-plugin-updater` + `tauri-plugin-process`             |
| Rust init      | `src-tauri/src/main.rs`                     | `.plugin(tauri_plugin_updater::Builder::new().build())`              |
| Bundler config | `src-tauri/tauri.conf.json`                 | `createUpdaterArtifacts: true`, `pubkey`, `endpoints`                |
| Permissions    | `src-tauri/capabilities/default.json`       | Grants `updater:default` + `process:default` to the WebView          |
| JS bridge      | `public/tauri-bridge.js`                    | Wraps `check()` / `downloadAndInstall()` / `relaunch()`              |
| UI             | `public/index.html`, `public/app.js`        | Settings → Updates panel + silent background check on startup        |
| CI             | `.github/workflows/release.yml`             | Injects signing key, runs `tauri-action`, attaches `latest.json`     |

## Disabling auto-updates for a build

If you want to ship an internal build without auto-updates (e.g. a
debug-signed local DMG), simply build without `TAURI_SIGNING_PRIVATE_KEY`
set. The bundler will still produce installers but no `.sig`/`latest.json`,
and the in-app updater check will report "no update available" (because
the manifest will 404).
