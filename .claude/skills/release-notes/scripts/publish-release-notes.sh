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

# Resolve the repo from the origin remote so gh never falls back to a wrong
# default (e.g. an upstream fork) when no default repo is configured.
REPO="$(git remote get-url origin 2>/dev/null \
  | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
if [[ -z "$REPO" ]]; then
  echo "error: could not resolve repo from 'origin' remote" >&2
  exit 1
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release edit "$TAG" --repo "$REPO" --notes-file "$NOTES_FILE"
  echo "Updated GitHub release body for $TAG ($REPO)"
else
  gh release create "$TAG" --repo "$REPO" --notes-file "$NOTES_FILE" --verify-tag --title "Picot $TAG"
  echo "Created GitHub release $TAG ($REPO)"
fi
