#!/usr/bin/env node
/**
 * Bundle each pi extension TypeScript source under `extensions/` into a
 * self-contained CommonJS file under `extensions/dist/`.
 *
 * Why this exists
 * ---------------
 * pi loads extensions with jiti and resolves their `import` statements via
 * Node's module algorithm at runtime. In dev that works because the source
 * lives next to this repo's `node_modules/`. Inside a packaged `.app`, the
 * raw `extensions/*.ts` is shipped without `node_modules`, so any non-builtin
 * import (e.g. `ws`, `qrcode`) fails with `Cannot find module`. Bundling here
 * inlines those deps so the shipped extension is fully self-contained.
 *
 * Notes
 * - We keep node built-ins external (esbuild does this automatically with
 *   `platform: "node"`).
 * - `@earendil-works/pi-coding-agent` (and its legacy `@mariozechner/...`
 *   alias) are external too: extensions only `import type` from them, but we
 *   still mark them external defensively in case any value-level imports are
 *   added later — the pi runtime provides those at load time.
 * - Output is `.mjs` (ESM). pi's extension loader treats the module's
 *   `export default` as the factory function. Bundling as CJS hides the
 *   default behind `module.exports.default`, which jiti does not unwrap, so
 *   pi rejects it with "Extension does not export a valid factory function".
 */

const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "extensions");
const OUT_DIR = path.join(SRC_DIR, "dist");

// [inputPath, outputName] — outputName defaults to inputPath with .ts→.mjs
const ENTRIES = [
  ["embedded-server.ts"],
  ["picot-bridge.ts"],
  ["pi-chat-src/extension-entry.ts", "pi-chat.mjs"],
];

const EXTERNAL = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-tui",
  "@sinclair/typebox",
  "typebox",
];

async function buildOne(entrySpec) {
  const [entry, outName] = Array.isArray(entrySpec) ? entrySpec : [entrySpec];
  const inFile = path.join(SRC_DIR, entry);
  if (!fs.existsSync(inFile)) {
    console.warn(`[build-extensions] skip missing entry: ${entry}`);
    return;
  }
  const outFile = path.join(OUT_DIR, outName || entry.replace(/\.ts$/, ".mjs"));
  await esbuild.build({
    entryPoints: [inFile],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: EXTERNAL,
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel: "info",
    // Some bundled CJS deps (e.g. `ws`, `qrcode`) expect `require` /
    // `__dirname` / `__filename` to exist at runtime. esbuild's ESM output
    // does not provide them, so we shim them via banner.
    banner: {
      js: [
        "import { createRequire as __piCreateRequire } from 'node:module';",
        "import { fileURLToPath as __piFileURLToPath } from 'node:url';",
        "import { dirname as __piDirname } from 'node:path';",
        "const require = __piCreateRequire(import.meta.url);",
        "const __filename = __piFileURLToPath(import.meta.url);",
        "const __dirname = __piDirname(__filename);",
      ].join("\n"),
    },
  });
  const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`[build-extensions] ${entry} -> ${path.relative(ROOT, outFile)} (${sizeKb} KB)`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const entry of ENTRIES) {
    await buildOne(entry);
  }
}

main().catch((err) => {
  console.error("[build-extensions] failed:", err);
  process.exit(1);
});
