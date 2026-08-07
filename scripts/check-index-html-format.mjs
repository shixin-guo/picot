// ABOUTME: Guards public/index.html against silent full-file reformatting.
//
// The repo commits index.html in its original 4-space layout (legacy from the
// upstream template). Some HTML cleaners — including the edit tooling used in
// this repo — normalize the whole file to biome's 2-space style on any edit,
// which turns a one-line change into a 3,900-line whitespace diff. This check
// detects that: it strips all whitespace from HEAD's committed version and from
// the working tree, and if the two are byte-identical the diff is pure
// formatting — an accidental reformat, not a real edit.
//
// Exit 0 = no reformat detected (either clean tree or real content changes).
// Exit 1 = reformat detected; print the exact recovery command.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const file = "public/index.html";
const root = resolve(import.meta.dirname, "..");

// Clean tree — nothing to check.
try {
  execSync(`git diff --quiet -- ${file}`, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  console.log(`✓ ${file}: no uncommitted changes`);
  process.exit(0);
} catch {
  // git diff --quiet exits 1 when there ARE changes — fall through to the check.
}

function stripWhitespace(text) {
  return text.replace(/\s+/g, "");
}

let headText;
try {
  headText = execSync(`git show HEAD:${file}`, { cwd: root, encoding: "utf8" });
} catch {
  // No HEAD (fresh checkout without commits) — nothing to compare against.
  console.log(`✓ ${file}: no HEAD to compare (skipped)`);
  process.exit(0);
}

let workText;
try {
  workText = readFileSync(resolve(root, file), "utf8");
} catch {
  // File does not exist in the working tree (deleted?) — not our concern here.
  process.exit(0);
}

const headStripped = stripWhitespace(headText);
const workStripped = stripWhitespace(workText);

if (headStripped === workStripped) {
  // Content is identical after stripping whitespace → pure formatting diff.
  console.error(`✗ ${file}: working tree differs from HEAD only by whitespace/formatting`);
  console.error("  This is an accidental full-file reformat, not a real edit. Recover the");
  console.error("  committed formatting, then re-apply your edit:");
  console.error(`  git checkout HEAD -- ${file}`);
  process.exit(1);
}

console.log(`✓ ${file}: no formatting-only diff (content differs from HEAD)`);
process.exit(0);
