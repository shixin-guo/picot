#!/usr/bin/env node
/**
 * Builds browser-only ESM vendor bundles for CodeMirror and PDF.js.
 *
 * Source modules import @codemirror/* and pdfjs-dist directly from node_modules
 * (resolved by Vitest). At browser runtime, index.html contains an import map
 * that redirects those specifiers to the same-origin generated files under
 * public/vendor/.
 *
 * Outputs:
 *   public/vendor/codemirror.js     — all CodeMirror runtime exports used by the app
 *   public/vendor/pdf.js            — PDF.js facade (getDocument, GlobalWorkerOptions)
 *   public/vendor/pdf.worker.js     — PDF.js worker
 */

const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "vendor");

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
};

/** @type {import('esbuild').BuildOptions[]} */
const entries = [
  {
    ...common,
    entryPoints: [path.join(ROOT, "public", "codemirror-vendor-entry.js")],
    outfile: path.join(OUT_DIR, "codemirror.js"),
  },
  {
    ...common,
    entryPoints: [path.join(ROOT, "public", "pdf-vendor-entry.js")],
    outfile: path.join(OUT_DIR, "pdf.js"),
  },
  {
    ...common,
    entryPoints: [
      path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
    ],
    outfile: path.join(OUT_DIR, "pdf.worker.js"),
  },
];

async function buildOnce() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const entry of entries) {
    await esbuild.build(entry);
    const outPath = entry.outfile;
    const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log(`[build-frontend] ${path.relative(ROOT, outPath)} (${sizeKb} KB)`);
  }
}

async function buildWatch() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const contexts = [];
  for (const entry of entries) {
    const ctx = await esbuild.context(entry);
    contexts.push(ctx);
    await ctx.watch();
    console.log(
      `[build-frontend] watching ${path.relative(ROOT, entry.entryPoints[0])} → ${path.relative(ROOT, entry.outfile)}`,
    );
  }
  console.log("[build-frontend] watch mode active. Press Ctrl+C to stop.");
}

async function main() {
  const watch = process.argv.includes("--watch");
  try {
    if (watch) {
      await buildWatch();
    } else {
      await buildOnce();
      console.log("[build-frontend] done.");
    }
  } catch (err) {
    console.error("[build-frontend] failed:", err);
    process.exit(1);
  }
}

main();
