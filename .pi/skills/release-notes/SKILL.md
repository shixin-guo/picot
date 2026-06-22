---
name: release-notes
description: Write and publish GitHub release notes for a Picot version tag. Use when cutting a release or when the user asks to write/update release notes, or runs /skill:release-notes <tag>. You write the notes from the commit list; helper scripts collect the commits and publish to the GitHub release via gh. No API key or auth.json needed.
---

# Release Notes

You (the agent) write the release notes. The helper scripts only gather commits
and publish the result. Local workflow — no API key, no auth.json, uses the
already-authenticated `gh` CLI.

## Steps

1. **Collect material.** Tag defaults to the most recent tag if the user did not
   give one.
   ```bash
   .pi/skills/release-notes/scripts/collect-commits.sh <tag>
   ```
   Output gives `tag=`, `prev_tag=`, `compare_url=`, and the deduplicated commit
   list.

2. **Write the notes yourself** as GitHub-flavored Markdown:
   - Group under `### Features`, `### Fixes`, `### Other`; omit empty groups.
   - One concise bullet per user-visible change. Merge trivial/internal commits,
     rewrite terse commit subjects into clear, human descriptions.
   - No emojis, no marketing fluff. Never invent changes not in the commit list.
   - Last content line: `**Full Changelog**: <compare_url>` (use the value from step 1).
   - Then:
     ```
     ---
     Download the installer for your platform from the assets below.
     ```
   - Save to a temp file, e.g. `/tmp/release-notes-<tag>.md`.

3. **Show the draft to the user and get confirmation** before publishing.

4. **Publish** after approval:
   ```bash
   .pi/skills/release-notes/scripts/publish-release-notes.sh <tag> /tmp/release-notes-<tag>.md
   ```
   Edits the existing release, or creates it if missing.
