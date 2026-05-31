#!/usr/bin/env node
/**
 * Verify that the bundled mirror-server extension is *self-contained* —
 * i.e. it can be loaded by `pi --extension ...` from a directory that has
 * no `node_modules/` anywhere up the tree, and the resulting HTTP server
 * answers `/api/health` and `/api/sessions`.
 *
 * Why this exists
 * ---------------
 * Before this script, regressions where the bundle silently depended on
 * a `node_modules/ws` (or `qrcode`) reachable from the user's cwd would
 * "work" on the developer's machine and fail everywhere else, surfacing
 * to end users only as "Failed to load sessions / Disconnected". This
 * script reproduces the strict environment a real installed .app sees.
 *
 * Skip vs. fail
 * -------------
 * If `pi` is not installed on the runner, we skip with exit code 0 and
 * a loud warning, because the rest of the build pipeline does not depend
 * on pi being present. CI workflows that *do* expect pi can install it
 * themselves and rely on this script's exit code to gate the release.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "extensions", "dist", "embedded-server.mjs");
const PORT = 39101 + Math.floor(Math.random() * 100);

function fail(msg) {
  console.error(`[smoke-extensions] FAIL: ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`[smoke-extensions] ${msg}`);
}

function checkPiAvailable() {
  const probe = spawnSync("pi", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return null;
  }
  return (probe.stdout || probe.stderr || "").trim();
}

function get(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
  });
}

async function waitForHealth(port, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { body } = await get(`http://localhost:${port}/api/health`);
      return body;
    } catch (_err) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`/api/health never came up on port ${port}`);
}

async function main() {
  if (!fs.existsSync(BUNDLE)) {
    fail(
      `bundle not found at ${BUNDLE}. Run \`bun run build:extensions\` first.`
    );
  }
  info(`bundle: ${BUNDLE} (${(fs.statSync(BUNDLE).size / 1024).toFixed(1)} KB)`);

  const piVersion = checkPiAvailable();
  if (!piVersion) {
    info("pi not found in PATH; skipping smoke test (this is OK in environments without pi).");
    process.exit(0);
  }
  info(`pi available: ${piVersion}`);

  // Use a tmpdir as cwd so jiti cannot "rescue" the bundle by finding the
  // repo's node_modules/ up-tree. This is the strictest possible lookup
  // environment, matching what an installed .app sees on a fresh machine.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-"));
  info(`spawning pi from sandbox cwd: ${sandbox}`);

  const child = spawn(
    "pi",
    ["--extension", BUNDLE, "--mode", "rpc"],
    {
      cwd: sandbox,
      env: { ...process.env, PI_STUDIO_PORT: String(PORT) },
      // pi --mode rpc treats stdin closing as a shutdown signal, so we keep
      // stdin piped (and never write to it) for the lifetime of the test.
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  let stderrBuf = "";
  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderrBuf += s;
    if (process.env.SMOKE_VERBOSE) {
      process.stderr.write(`[pi-stderr] ${s}`);
    }
  });
  child.on("error", (err) => {
    info(`pi spawn error: ${err}`);
  });

  const exitPromise = new Promise((resolve) => child.on("exit", resolve));

  let ok = false;
  try {
    const health = await waitForHealth(PORT);
    info(`/api/health -> ${health}`);
    if (!health.includes('"status":"ok"')) {
      throw new Error(`/api/health did not report ok: ${health}`);
    }
    const sessions = await get(`http://localhost:${PORT}/api/sessions`);
    if (!sessions.body.startsWith("{")) {
      throw new Error(`/api/sessions did not return JSON: ${sessions.body.slice(0, 200)}`);
    }
    info(`/api/sessions returned ${sessions.body.length} bytes of JSON`);
    ok = true;
  } catch (err) {
    console.error("[smoke-extensions] pi stderr was:");
    console.error(stderrBuf || "(empty)");
    fail(err.message);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      exitPromise,
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch (_) {}
  }

  if (ok) {
    info("PASS: bundle is self-contained and serves /api/sessions");
  }
}

main().catch((err) => {
  console.error("[smoke-extensions] unexpected error:", err);
  process.exit(1);
});
