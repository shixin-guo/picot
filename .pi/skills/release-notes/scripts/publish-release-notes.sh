#!/usr/bin/env bash
# Publish an already-written release-notes file to a tag's GitHub release.
# The notes are written by the agent; this script only does the gh call.
#
# Usage: scripts/publish-release-notes.sh <tag> <notes-file>
set -euo pipefail

TAG="${1:-}"
NOTES_FILE="${2:-}"

if [[ -z "$TAG" || -z "$NOTES_FILE" ]]; then
  echo "usage: $0 <tag> <notes-file>" >&2
  exit 1
fi
if [[ ! -f "$NOTES_FILE" ]]; then
  echo "error: notes file '$NOTES_FILE' not found" >&2
  exit 1
fi
if ! git rev-parse --verify "$TAG" >/dev/null 2>&1; then
  echo "error: tag '$TAG' does not exist" >&2
  exit 1
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release edit "$TAG" --notes-file "$NOTES_FILE"
  echo "Updated GitHub release body for $TAG"
else
  gh release create "$TAG" --notes-file "$NOTES_FILE" --verify-tag --title "Picot $TAG"
  echo "Created GitHub release $TAG"
fi
