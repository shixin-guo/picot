#!/usr/bin/env node
/**
 * Fetch the platform-specific pi binary tarball from pi-mono GitHub
 * releases and extract it into `src-tauri/resources/pi/` so the Tauri
 * bundle can ship a self-contained pi runtime.
 *
 * Why this exists
 * ---------------
 * Pi Studio used to find `pi` on the user's PATH, harvest API keys from
 * their login shell, and probe several install locations. That created a
 * long tail of "works on dev box, broken on Finder-launched .app" bugs.
 * By embedding a known pi version inside the .app, we make pi-studio's
 * runtime fully self-contained: it neither requires nor consults a
 * user-installed pi.
 *
 * Source of truth: `scripts/pi-version.json` (`version`, optional `sha256`
 * per-asset). Bumping the version is an explicit, reviewable change.
 *
 * Output: `src-tauri/resources/pi/` containing the extracted release tree
 * (binary `pi` / `pi.exe`, theme/, assets/, node_modules/, etc.) plus a
 * `.version` marker file used for idempotency.
 *
 * Idempotency
 * -----------
 * If `src-tauri/resources/pi/.version` already equals the locked version
 * AND the expected binary path exists, the script exits 0 immediately.
 * Useful so `prebuild` / `dev` can run it unconditionally without paying
 * the download cost on every invocation.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(__dirname, "pi-version.json");
const CACHE_DIR = path.join(ROOT, ".cache", "pi-binaries");
const OUT_DIR = path.join(ROOT, "src-tauri", "resources", "pi");
const VERSION_MARKER = path.join(OUT_DIR, ".version");

function info(msg) {
  console.log(`[fetch-pi] ${msg}`);
}

function warn(msg) {
  console.warn(`[fetch-pi] WARN: ${msg}`);
}

function fail(msg) {
  console.error(`[fetch-pi] FAIL: ${msg}`);
  process.exit(1);
}

function platformAssetName() {
  const platform = process.platform;
  const arch = process.arch;
  // Optional override useful for CI / multi-arch packaging where the host
  // platform is not the target. Format: "darwin-arm64", "linux-x64", etc.
  const override = process.env.PI_TARGET_PLATFORM;
  let key;
  if (override) {
    key = override;
  } else if (platform === "darwin" && arch === "arm64") {
    key = "darwin-arm64";
  } else if (platform === "darwin" && arch === "x64") {
    key = "darwin-x64";
  } else if (platform === "linux" && arch === "x64") {
    key = "linux-x64";
  } else if (platform === "linux" && arch === "arm64") {
    key = "linux-arm64";
  } else if (platform === "win32" && arch === "x64") {
    key = "windows-x64";
  } else if (platform === "win32" && arch === "arm64") {
    key = "windows-arm64";
  } else {
    fail(
      `Unsupported platform=${platform} arch=${arch}. ` +
        `Set PI_TARGET_PLATFORM to one of: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64.`,
    );
  }
  const isWindows = key.startsWith("windows-");
  return {
    key,
    archiveName: isWindows ? `pi-${key}.zip` : `pi-${key}.tar.gz`,
    binaryName: isWindows ? "pi.exe" : "pi",
    isZip: isWindows,
  };
}

function loadLockedVersion() {
  let raw;
  try {
    raw = fs.readFileSync(VERSION_FILE, "utf8");
  } catch (err) {
    fail(`Could not read ${VERSION_FILE}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`Invalid JSON in ${VERSION_FILE}: ${err.message}`);
  }
  if (!parsed.version || typeof parsed.version !== "string") {
    fail(`Missing "version" string in ${VERSION_FILE}`);
  }
  return {
    version: parsed.version.trim(),
    // Optional: { "pi-darwin-arm64.tar.gz": "<sha256 hex>", ... }
    sha256: parsed.sha256 && typeof parsed.sha256 === "object" ? parsed.sha256 : {},
  };
}

function isUpToDate(version, binaryName) {
  if (!fs.existsSync(VERSION_MARKER)) return false;
  let current;
  try {
    current = fs.readFileSync(VERSION_MARKER, "utf8").trim();
  } catch {
    return false;
  }
  if (current !== version) return false;
  const binPath = path.join(OUT_DIR, binaryName);
  if (!fs.existsSync(binPath)) return false;
  return true;
}

function ensureDirEmpty(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const cleanup = (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    };
    const handle = (res) => {
      // Follow redirects (GitHub release downloads always redirect to S3).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadTo(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        cleanup(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", cleanup);
    };
    https
      .get(url, { headers: { "User-Agent": "pi-studio-fetch" } }, handle)
      .on("error", cleanup);
  });
}

function sha256OfFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function flattenWrapperDir(outDir, wrapperName) {
  // Archives wrap the entire payload in a single directory named e.g. "pi/".
  // We extract into outDir and then promote that wrapper's contents up one
  // level so callers get a flat layout.
  //
  // Careful: when wrapperName itself collides with a file inside the wrapper
  // (the bun-compiled `pi` binary inside `pi/`), we cannot naively rename
  // children into outDir because the wrapper dir would be the rename target
  // for its own binary child. Rename the wrapper to a temp name first.
  const wrapper = path.join(outDir, wrapperName);
  if (!fs.existsSync(wrapper) || !fs.statSync(wrapper).isDirectory()) return;
  const tmpName = `${wrapperName}__pi_studio_tmp_${process.pid}`;
  const tmp = path.join(outDir, tmpName);
  fs.renameSync(wrapper, tmp);
  for (const entry of fs.readdirSync(tmp)) {
    fs.renameSync(path.join(tmp, entry), path.join(outDir, entry));
  }
  fs.rmdirSync(tmp);
}

function extractTarGz(archivePath, outDir) {
  // Use system tar — present on macOS and Linux runners, and reasonable to
  // require on dev machines targeting those platforms.
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", outDir], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`tar extraction failed (exit ${result.status})`);
  }
  flattenWrapperDir(outDir, "pi");
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait is fine here: extraction retry loop, ms is small.
  }
}

function extractZipWindows(archivePath, outDir) {
  // Strategy:
  //   1) Prefer `tar.exe` (bundled with Windows 10 1803+, including
  //      GitHub Actions windows-latest runners). It can unpack .zip via
  //      libarchive, is much faster than Expand-Archive, and does not
  //      hold exclusive locks on the source archive the way
  //      Microsoft.PowerShell.Archive does.
  //   2) Fall back to PowerShell `Expand-Archive`, but with
  //      $ErrorActionPreference='Stop' so errors actually propagate as a
  //      non-zero exit code (otherwise the script silently continues
  //      and only fails at the post-extraction binary-existence check).
  //      Retry a few times on the classic "file is being used by another
  //      process" error caused by antivirus scanning the freshly
  //      downloaded archive.
  const tarResult = spawnSync("tar", ["-xf", archivePath, "-C", outDir], {
    stdio: "inherit",
  });
  if (tarResult.status === 0) return;
  if (tarResult.error && tarResult.error.code !== "ENOENT") {
    warn(`tar.exe extraction failed (${tarResult.error.message}); falling back to Expand-Archive.`);
  } else if (tarResult.status !== null) {
    warn(`tar.exe extraction exited ${tarResult.status}; falling back to Expand-Archive.`);
  }

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const psResult = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$ErrorActionPreference='Stop'; Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${outDir}'`,
      ],
      { stdio: "inherit" },
    );
    if (psResult.status === 0) return;
    if (attempt < maxAttempts) {
      warn(
        `Expand-Archive failed (exit ${psResult.status}); retrying in 1s (attempt ${attempt}/${maxAttempts})…`,
      );
      sleepSync(1000);
    } else {
      fail(`zip extraction failed on Windows after ${maxAttempts} attempts (exit ${psResult.status})`);
    }
  }
}

function extractZip(archivePath, outDir) {
  if (process.platform === "win32") {
    extractZipWindows(archivePath, outDir);
  } else {
    const result = spawnSync("unzip", ["-q", "-o", archivePath, "-d", outDir], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      fail(`zip extraction failed (exit ${result.status})`);
    }
  }
  // Note: Windows zip archives may or may not have a wrapper dir depending
  // on how they were created. Run flatten unconditionally; it's a no-op if
  // there's no wrapper.
  flattenWrapperDir(outDir, "pi");
}

async function main() {
  const { version, sha256 } = loadLockedVersion();
  const asset = platformAssetName();

  info(`locked pi version: ${version}`);
  info(`target asset: ${asset.archiveName}`);

  if (isUpToDate(version, asset.binaryName)) {
    info(`already up to date at ${OUT_DIR}; skipping.`);
    return;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachedArchive = path.join(CACHE_DIR, `${version}-${asset.archiveName}`);
  const expectedSha = sha256[asset.archiveName];

  if (fs.existsSync(cachedArchive)) {
    if (expectedSha) {
      const actual = sha256OfFile(cachedArchive);
      if (actual !== expectedSha) {
        warn(
          `cached archive checksum mismatch (expected ${expectedSha}, got ${actual}); re-downloading.`,
        );
        fs.unlinkSync(cachedArchive);
      } else {
        info(`using cached archive: ${cachedArchive}`);
      }
    } else {
      info(`using cached archive: ${cachedArchive}`);
    }
  }

  if (!fs.existsSync(cachedArchive)) {
    const url = `https://github.com/earendil-works/pi-mono/releases/download/v${version}/${asset.archiveName}`;
    info(`downloading ${url}`);
    try {
      await downloadTo(url, cachedArchive);
    } catch (err) {
      fail(
        `download failed: ${err.message}\n` +
          `  - check network connectivity\n` +
          `  - verify v${version} exists at https://github.com/earendil-works/pi-mono/releases\n` +
          `  - if the version was just published, the asset may take a few minutes to propagate`,
      );
    }
  }

  if (expectedSha) {
    const actual = sha256OfFile(cachedArchive);
    if (actual !== expectedSha) {
      try {
        fs.unlinkSync(cachedArchive);
      } catch {}
      fail(
        `sha256 mismatch for ${asset.archiveName}: expected ${expectedSha}, got ${actual}. ` +
          `Cached archive removed.`,
      );
    }
    info(`sha256 verified.`);
  } else {
    warn(
      `no sha256 pin for ${asset.archiveName} in scripts/pi-version.json — skipping checksum verification.`,
    );
  }

  info(`extracting to ${OUT_DIR}`);
  ensureDirEmpty(OUT_DIR);
  if (asset.isZip) {
    extractZip(cachedArchive, OUT_DIR);
  } else {
    extractTarGz(cachedArchive, OUT_DIR);
  }

  const binPath = path.join(OUT_DIR, asset.binaryName);
  if (!fs.existsSync(binPath)) {
    fail(
      `extraction succeeded but ${binPath} is missing. ` +
        `The release archive layout may have changed.`,
    );
  }
  // tar preserves +x; zip on Windows handles .exe natively. On Unix we
  // belt-and-braces chmod the binary to guard against odd archive sources.
  if (!asset.isZip) {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch {}
  }

  // On macOS, ad-hoc re-sign the binary so macOS AMFI accepts spawning
  // multiple instances. Downloaded binaries often have an invalid/foreign
  // signature; AMFI caches approval for the first spawn but kills subsequent
  // ones with SIGKILL when it re-validates and finds a bad signature.
  if (process.platform === "darwin") {
    try {
      const { execFileSync } = await import("child_process");
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", binPath]);
      info(`codesign: ad-hoc signed ${binPath}`);
    } catch (e) {
      // Non-fatal: warn but don't block the install. The app may still work
      // if the existing signature happens to be valid.
      info(`codesign: warning — could not re-sign ${binPath}: ${e.message}`);
    }
  }

  fs.writeFileSync(VERSION_MARKER, version, "utf8");
  info(`installed pi ${version} -> ${binPath}`);
}

main().catch((err) => {
  fail(`unexpected error: ${err.stack || err.message || err}`);
});
