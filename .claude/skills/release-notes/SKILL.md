---
name: release-notes
description: Cut a Picot release and/or write and publish its GitHub release notes. Use when the user asks to cut a release, bump the version, or write/update release notes, or runs /skill:release-notes <version>. Uses the existing scripts/release.sh to bump versions + tag + push, then you write the notes and a helper publishes them via gh. No API key or auth.json needed.
---

# Release Notes

Two phases. Phase 1 (cut the release) is optional — skip it if the tag already
exists and CI has already built it. You (the agent) write the notes; helper
scripts handle versioning and the `gh` calls. Local workflow, no API key.

## Phase 1 — Cut the release (only if the tag does not exist yet)

The repo already has a release script that bumps the version everywhere
(`tauri.conf.json`, `package.json`, `Cargo.toml` + lockfiles), commits, tags,
and pushes — which triggers the Release workflow that builds installers and
creates the GitHub release.

```bash
bun run release <version>      # e.g. bun run release 0.2.2  (or v0.2.2)
```

Do NOT manually `git tag` — that skips the version bump and produces installers
whose filenames lag the tag. Always go through `bun run release`.

Requirements it enforces: clean working tree, on a branch (not detached), tag
not already present locally or on origin.

After it pushes, the Release workflow runs (tauri-action typically ~7 min; the
release appears once the first platform job finishes uploading). Poll until the
GitHub release for the tag exists, then proceed to phase 2:

```bash
# poll roughly every 60s; the release shows up after the first job uploads
until gh release view <tag> --json name >/dev/null 2>&1; do
  gh run list --workflow Release --limit 1
  sleep 60
done
gh release view <tag> --json name,assets --jq '{name, assets:(.assets|length)}'
```

## Phase 2 — Write and publish the notes

1. **Collect material** (tag defaults to the most recent tag):
   ```bash
   .pi/skills/release-notes/scripts/collect-commits.sh <tag>
   ```
   Gives `tag=`, `prev_tag=`, `compare_url=`, and the deduplicated commit list.

2. **Write the notes yourself** as GitHub-flavored Markdown:
   - Group under `### Features`, `### Fixes`, `### Other`; omit empty groups.
   - One concise bullet per user-visible change; merge trivial/internal commits
     and rewrite terse subjects into clear descriptions.
   - No emojis, no fluff. Never invent changes not in the commit list.
   - Last content line: `**Full Changelog**: <compare_url>` from step 1.
   - Then:
     ```
     ---
     Download the installer for your platform from the assets below.
     ```
   - Save to `/tmp/release-notes-<tag>.md`.

3. **Show the draft and get confirmation** before publishing.

4. **Publish** after approval:
   ```bash
   .pi/skills/release-notes/scripts/publish-release-notes.sh <tag> /tmp/release-notes-<tag>.md
   ```
   The script derives the repo from the `origin` remote, passes `--repo`
   explicitly, and edits the release (or creates it if missing).

## Notes

- If the user gives a version with no existing tag, do phase 1 then phase 2.
- If the tag already exists and is built, do phase 2 only.
