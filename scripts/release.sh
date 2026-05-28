#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  echo "Usage: $0 <version>"
  echo "Example: $0 0.1.6  (or: $0 v0.1.6)"
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

RAW_VERSION="$1"
VERSION="${RAW_VERSION#v}"
TAG="v$VERSION"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid version: $RAW_VERSION"
  echo "Expected: 0.1.6 or v0.1.6 (supports prerelease/build suffixes)"
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" == "HEAD" ]]; then
  echo "Detached HEAD is not supported for release."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is not clean. Commit/stash your changes first."
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag already exists locally: $TAG"
  exit 1
fi

if git ls-remote --tags origin "refs/tags/$TAG" | rg -q "$TAG$"; then
  echo "Tag already exists on origin: $TAG"
  exit 1
fi

echo "Updating versions to $VERSION..."
node <<'EOF' "$VERSION"
const fs = require("fs");
const path = require("path");

const version = process.argv[2];
const root = process.cwd();

const jsonFiles = [
  path.join(root, "src-tauri", "tauri.conf.json"),
  path.join(root, "package.json"),
];

for (const file of jsonFiles) {
  const content = JSON.parse(fs.readFileSync(file, "utf8"));
  content.version = version;
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + "\n");
}

const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const cargo = fs.readFileSync(cargoPath, "utf8");
const updated = cargo.replace(
  /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/,
  `$1${version}$3`,
);
if (updated === cargo) {
  throw new Error("Failed to update version in src-tauri/Cargo.toml");
}
fs.writeFileSync(cargoPath, updated);
EOF

echo "Committing release version bump..."
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json
git commit -m "chore(release): $TAG"

echo "Creating tag $TAG..."
git tag "$TAG"

echo "Pushing branch ($CURRENT_BRANCH) and tag ($TAG)..."
git push origin "$CURRENT_BRANCH"
git push origin "$TAG"

echo
echo "Release pushed successfully:"
echo "  branch: $CURRENT_BRANCH"
echo "  tag:    $TAG"
