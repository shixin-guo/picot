#!/usr/bin/env bash
# Print the raw material for writing release notes: resolved tag, previous tag,
# compare URL, and the deduplicated commit list for the range. No AI, no network.
#
# Usage: scripts/collect-commits.sh [tag]   (tag defaults to most recent tag)
set -euo pipefail

# Derive the repo slug from the origin remote (no hardcoded name).
REPO_SLUG="$(git remote get-url origin 2>/dev/null \
  | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
REPO_SLUG="${REPO_SLUG:-shixin-guo/picot}"
TAG="${1:-$(git describe --tags --abbrev=0)}"

if ! git rev-parse --verify "$TAG" >/dev/null 2>&1; then
  echo "error: tag '$TAG' does not exist" >&2
  exit 1
fi

PREV_TAG="$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)"
if [[ -n "$PREV_TAG" ]]; then
  RANGE="${PREV_TAG}..${TAG}"
  echo "compare_url=https://github.com/${REPO_SLUG}/compare/${PREV_TAG}...${TAG}"
else
  RANGE="$TAG"
  echo "compare_url=https://github.com/${REPO_SLUG}/commits/${TAG}"
fi
echo "tag=$TAG"
echo "prev_tag=${PREV_TAG:-(none)}"
echo "--- commits ---"
git log --no-merges --pretty=format:'- %s' "$RANGE" \
  | grep -viE '^- chore\(release\)|^- release v|^- v[0-9]+\.[0-9]+' \
  | awk '!seen[$0]++'
