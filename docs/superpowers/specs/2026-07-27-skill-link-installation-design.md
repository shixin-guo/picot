# Skill Link Installation Design

## Status

Approved design derived from discussion with Dr. Lin on 2026-07-27. The static
visual reference is [`skill-install-prototype.html`](../../../skill-install-prototype.html).
This document extends the existing Skills discovery/configuration design and
the Claude Code skills discovery proposal. The final Skills information
architecture is the three-tab model in
[`2026-07-27-package-skills-tab-design.md`](2026-07-27-package-skills-tab-design.md):
**Discovered**, **Install**, and **Packages skills**. It defines an explicit
installation workflow; it does not change Pi's native resource resolver.

## Goal

Add an **Install** tab to Settings > Skills. A desktop owner selects any local
directory through the system folder picker, reviews the skill groups and skills
found beneath it, selects a global or trusted-project target, and explicitly
adds Pi-compatible source paths to that target scope's `settings.json`.

This is a **link configuration** workflow only: it never copies, moves,
deletes, edits, or creates symbolic links for skill files. Pi loads selected
skills from their original locations after a new session begins or the Pi
process restarts.

## Non-goals

- Copying skills into `~/.agents/skills/` or `<cwd>/.agents/skills/`;
- filesystem symbolic links, junctions, aliases, or shortcuts;
- installation records, automatic update checks, reinstall, or uninstall UI;
- a Skill Paths editor or a project-level Configuration editor;
- changing existing `!`, `+`, or `-` rules while installing;
- enabling, disabling, deleting, or editing a selected source skill;
- auto-installing a discovered skill root;
- reloading skills in a running Pi process;
- LAN, mobile, temporary-chat, or ephemeral-client access to local source paths
  or settings mutations.

Removing a linked root remains an advanced configuration operation. This first
version does not add a dedicated removal affordance or project-settings editor.

## Product Decisions

| Concern | Decision |
| --- | --- |
| Skills page information architecture | Settings > Skills contains three inner tabs: **Discovered** for the existing inventory and effective enable/disable state, **Install** for this workflow, and read-only **Packages skills** for configured Pi package resources. |
| Source selection | The user may select any local directory through the system folder picker, including workspace-internal directories, `.claude/skills`, and directories outside the workspace. Browser-provided paths are never authoritative. |
| Source discovery | If the chosen directory contains `SKILL.md`, it is one selectable skill. Otherwise Picot recursively discovers groups and skills below it. |
| Selectable units | Both groups and individual skills are selectable. Selecting a group initially selects all descendant skills; the user may deselect individual descendants. |
| Group path granularity | A completely selected group adds one source path for that group. A partially selected group adds one source path per selected skill, never the broader group path. |
| Install mechanism | Link configuration only: append selected plain paths to the `skills` array in the selected Pi settings file. No copy mode exists. |
| Scope | Global writes `~/.pi/agent/settings.json`. Current project writes `<cwd>/.pi/settings.json` and is disabled unless the retained Pi context reports the project trusted. |
| Path serialization | Generate a portable POSIX path relative to the target Pi resource base when that representation resolves reliably; otherwise serialize a POSIX absolute path. |
| Deduplication | Resolve and canonicalize existing ordinary source paths against the target Pi resource base. If one already resolves to the same selected source directory, mark it configured and do not add a duplicate, even if stored text differs. |
| Existing rules | Preserve all existing `!`, `+`, and `-` rules. Install never deletes, reorders, or rewrites them. Show their resolved effect when they leave a selected skill disabled. |
| Name collisions | Permit installation. Show the Pi-compatible winning skill and any selected skill shadowed by a frontmatter-name collision; do not falsely claim every installed skill registers a command. |
| Pre-write validation | Rescan/revalidate every selected source immediately before writing. If any selected source vanished, is unreadable, is invalid, or no longer satisfies the requested group/skill identity, return an error and write nothing. |
| Settings write | Read the latest JSON object under the existing Pi-compatible settings lock, preserve unrelated keys and every unmanaged `skills` entry, append only missing plain paths, atomically replace the file, recompute the inventory, and return `runtimeRestartRequired: true`. |
| Confirmation | The Install button opens a final confirmation dialog; no settings file changes before explicit confirmation. |
| Completion | On success stay on the Install tab, replace the server-backed result, and show that a new Pi session or Pi-process restart is required. Do not automatically switch to Discovered. |

## User Experience

### Page structure

The Skills primary Settings item retains the existing page shell and offers:

```text
Skills
├─ Discovered
│  └─ existing inventory, diagnostics, effective status, group/skill controls
├─ Install
│  └─ system-folder selection, scan, selection, target scope, preview, confirmation
└─ Packages skills
   └─ read-only configured-package skill inventory
```

The Install tab is a numbered, linear form but keeps already scanned selection
state while the user changes scope or opens/closes the confirmation dialog.

### 1. Choose a skill directory

The user selects a directory with a button such as **Choose directory…**. The
native host opens the OS folder picker (Finder on macOS), canonicalizes the
chosen path inside the host, and returns only an opaque `sourceId` to the
authenticated desktop-owner WebView. A later authenticated scan response may
disclose the canonical path to that same owner for review, but the browser
never receives it from the picker and never submits a path as scan or mutation
authority. No path or handle is exposed to remote clients.

The server scans the result and reports one of:

- a single selected-directory skill when that directory contains `SKILL.md`;
- a nested tree of groups and skills when the selected directory is a collection
  root;
- diagnostics for unreadable/invalid candidates;
- an empty state when no valid candidate exists.

No valid selectable skill means Install remains disabled.

Discovery uses the same safety and structure rules as the inventory:

- a directory containing `SKILL.md` is one skill and stops recursion below it;
- hidden directories and `node_modules` are skipped;
- `.gitignore`, `.ignore`, and `.fdignore` exclusions apply;
- canonical paths deduplicate symlink aliases;
- invalid or unreadable `SKILL.md` produces a localized diagnostic instead of
  crashing the scan.

### 2. Select groups and skills

A tree lists group headers and child skill rows, each showing the frontmatter
name, description, and canonical source path in accessible text or tooltip.

- Checking a group checks all descendant skills.
- Unchecking one child leaves its ancestor group visually indeterminate.
- Complete group selection serializes one group directory path. The preview and
  confirmation explicitly warn that Pi recursively discovers the directory, so
  skills added beneath it later will also load in future Pi sessions.
- Partial group selection serializes the selected skill directories separately.
- A source directory that is itself a single skill is selected as one skill and
  serializes its containing skill directory.

Before confirmation, the page resolves the selected candidates against existing
configuration and current inventory. Each candidate is annotated as applicable:

- **Will add:** a missing source path will be appended;
- **Already configured:** a canonical-equivalent ordinary source path exists;
  it will not be duplicated;
- **Disabled by existing rule:** the path may be added but the result remains
  disabled due to an existing `!` or `-` rule;
- **Shadowed:** it may load as a resource but loses the command name to the
  displayed winner;
- **Invalid:** it cannot be installed and blocks confirmation.

### 3. Choose where Pi loads the skills

A segmented control provides:

- **Global install**, targeting `~/.pi/agent/settings.json` and using
  `~/.pi/agent/` as its Pi resource base;
- **Current project**, targeting `<cwd>/.pi/settings.json` and using
  `<cwd>/.pi/` as its Pi resource base.

The Current project choice is disabled until `ctx.isProjectTrusted()` is true.
The host derives `cwd`, home directory, agent directory, and trust state from
its retained context; the browser cannot submit a target settings path.

For every ordinary selected source directory, the server calculates the target
settings entry as follows:

1. derive a POSIX relative path from the selected scope's Pi resource base;
2. resolve that text through Pi-compatible local-path resolution and confirm it
   identifies the canonical selected directory;
3. use it when it round-trips reliably; otherwise use a POSIX absolute path.

If a source is outside the workspace but a valid relative path exists, it may
still be stored relatively. The preview labels it as potentially invalid if the
project or source directory is moved. A stronger team-portability warning
applies **only** under the precise condition
`target = "project" ∧ canonicalSource is strictly under the host home
directory ∧ canonicalSource is not under the project root`: the resulting
project settings entry is machine-specific and, if committed to Git, will not
resolve for other team members. It must not fire when the source is inside the
project (even if also under the home directory), nor when the target is global.
The UI recommends Global install for that case but leaves the explicit project
choice available. No path is rewritten merely to prefer an absolute
representation.

### 4. Preview and confirm

The pre-confirmation preview lists:

- target scope and exact target `settings.json` path;
- exact plain `skills` strings that will be appended;
- configured-equivalent paths that will be skipped;
- all effective disabled-by-rule and shadowed outcomes;
- a warning that moving the project or source can invalidate a relative link,
  with a stronger team-portability warning for a home-directory source linked
  from project settings;
- an explicit notice on every complete-group path that future skills added below
  that source directory will also be discovered by Pi;
- the selected skill name, description, and full canonical source path;
- a security notice: skills can contain instructions and executable scripts,
  and should be reviewed before enabling.

Clicking **Install** opens a confirmation dialog that repeats the settings file,
exact JSON-array additions, selected skill metadata, display-only canonical
source paths, warnings, and the restart requirement. Disclosure of those paths
to the authenticated desktop owner is permitted so the user can review the
selection; they remain server-issued display data, not mutation authority. The
dialog offers Cancel and an explicit **Install skills** action. It must not
present a copy/move/symlink operation.

### 5. Completion and failure

A successful response leaves the user in Install, reports the source paths
written or skipped, and states that the change applies only to a new Pi session
or a restarted Pi process.

A failure leaves selection and the last server-backed scan available, reports
the actionable server error inline, and makes no partial settings modification.

## Architecture

```text
Settings > Skills > Install (desktop-owner WebView)
  ├─ native broker / Tauri command: choose local source directory
  │    └─ OS folder picker → server-side opaque source handle
  └─ authenticated owner-only embedded-server RPC
       ├─ skill_scan_install_source { sourceId }
       │    └─ pure discovery / grouping / Pi-compatible preview resolver
       └─ skill_install_links { scope, sourceId, selection IDs, scanRevision }
            └─ lock → read → revalidate → minimal atomic settings mutation
                 └─ recomputed inventory + installation result
```

### Native directory picker and source-handle registry

Reuse only the native-dialog portion of the existing chat image attachment
pattern in `src-tauri/src/main.rs`: `app.dialog().file()` invokes platform
APIs, but the existing `pick_folder_core()` path-returning contract is not safe
to reuse as this feature's browser protocol.

The Rust host owns an in-memory source-handle registry. After the owner selects
a readable local directory, the host canonicalizes it and stores a record such
as:

```ts
{
  sourceId: string,              // cryptographically unpredictable
  canonicalPath: string,         // never accepted from the browser
  desktopOwnerId: string,
  workspaceId: string,
  workspaceGeneration: number,
  createdAt: number
}
```

The picker returns only `sourceId`. Scan and install requests travel through an
internal native broker path that resolves the record and conveys the canonical
path directly to the authorized embedded-server operation; the WebView cannot
exchange `sourceId` for a path or redirect it to another path. The registry and
broker contract must be documented alongside existing workspace routing rather
than implemented as an unrelated browser-accessible path lookup command.

A handle is valid only for its issuing desktop owner, workspace ID, and current
workspace generation. It has a bounded TTL, is revoked when its window closes,
its workspace generation changes, the app/Pi host restarts, or a replacement
directory is chosen for that Install form, and is consumed after a successful
install. Cancellation is a normal no-op and creates no handle. Unknown,
expired, consumed, cross-owner, cross-window, or cross-workspace handles are
rejected without revealing whether the underlying path exists. The picker,
registry resolution, scan, and install paths reject remote/mobile/LAN and all
ephemeral/temporary-chat callers, including an authenticated desktop owner
inside an ephemeral runtime.

### Pure installation module

Extend `extensions/skill-inventory.ts` or extract a tightly scoped companion
module, such as `extensions/skill-installation.ts`. It owns pure and testable:

- scan-root discovery and group tree construction for a chosen directory;
- stable opaque IDs for groups and skills within a scan revision;
- a `scanRevision` fingerprint covering the canonical root, candidate skill
  identities, and complete group membership relevant to path reduction;
- full-vs-partial group path reduction;
- frontmatter diagnostics and canonical-path deduplication;
- target-scope resource-base path serialization and round-trip validation;
- canonical-equivalence deduplication against ordinary configured source paths;
- preview annotations for existing rules and name collision precedence;
- revalidation of selected IDs immediately before mutation;
- minimal `skills` array mutation under the existing settings lock and atomic
  writer.

The installation request accepts only a closed scope value and opaque candidate
IDs issued by the current server scan. Immediately before writing, it rescans
and recomputes the revision. Any candidate identity or complete-group
membership change—including a skill added after confirmation—makes the
revision stale and requires a new preview and confirmation. This protects the
confirmation boundary; only descendants added after the group path has been
successfully configured acquire the documented future-live behavior. The
request also rejects unknown or cross-source IDs, malformed/non-object
settings, an untrusted project, an inaccessible root, and invalid selected
skills.

### Embedded server and authorization

Add owner-only commands with validated closed payloads, for example:

```ts
skill_scan_install_source {
  sourceId: string
}

skill_install_links {
  scope: "global" | "project",
  sourceId: string,
  scanRevision: string,
  selection: Array<{ kind: "group" | "skill"; id: string }>
}
```

The source handle and scan revision are mandatory. No command may accept an
arbitrary browser filesystem path, a browser-selected settings path, or a
browser-supplied replacement for the host-selected source as authority. Add
each command to the desktop-owner command policy and an explicit non-ephemeral
gate. The current `desktopOwnerOnly` classification alone permits an
authenticated owner in the ephemeral server path, so scan and install must
still reject that context, plus temporary chat, LAN, and mobile routes.

`skill_install_links` serializes mutations per target settings path with the
existing Pi-compatible `${settingsPath}.lock` protocol. It writes all missing
entries in a single atomic settings replacement; if pre-write revalidation
fails, it writes none.

### Frontend

Extend `public/settings/skills-page.js` or split a focused install-tab module
that owns only folder selection, server scan state, group/skill selection,
scope choice, preview, confirmation dialog, pending states, and response
rendering. `public/app.js` remains wiring only.

All source metadata and diagnostics render with DOM APIs and `textContent`,
never HTML string interpolation. Add English and Chinese locale keys; locale
completeness tests remain green. The static `skill-install-prototype.html`
provides the interaction and visual reference but is not production code.

## Persistence and Safety Invariants

- Selecting or scanning a source directory never writes a settings file.
- No install occurs without the explicit final confirmation action.
- The only settings delta is appending missing ordinary source-path strings to
  the target `skills` array.
- The picker returns only an opaque source handle. An authenticated scan or
  preview response may disclose canonical paths to the issuing desktop owner
  as display-only review data, but paths are never accepted back from the
  browser as scan or mutation authority.
- Preserve every unrelated settings key, all existing source paths, custom
  globs, and all `!`/`+`/`-` rules exactly and in their existing order.
- Do not duplicate a canonical-equivalent configured source even when its
  original string representation differs.
- Do not silently force-enable a source disabled by existing rules.
- Do not silently resolve a command-name collision by deleting, disabling, or
  rewriting either skill.
- Any selected-source validation failure before the atomic write aborts the
  whole installation mutation.
- A complete-group membership change between preview and pre-write rescan
  invalidates `scanRevision`; the user must review and confirm the new tree.
- A successful write never claims that an existing Pi process reloaded skills.
- The feature must not expose a selected host path or settings mutation
  capability to non-desktop-owner clients.

## Verification

### Pure discovery, preview, and mutation tests

Add deterministic tests covering:

- selected directory that is a single `SKILL.md` skill;
- selected directory with nested groups and multiple skills;
- complete group selection yields one group directory entry;
- partial group selection yields only selected individual skill directory
  entries;
- hidden directories, `node_modules`, ignore-file matches, nested-skill
  traversal termination, malformed frontmatter, unreadable sources, and
  symlink canonicalization;
- scope-specific resource bases, POSIX relative serialization, and absolute
  fallback when a relative entry cannot round-trip to the selected source;
- project-internal and project-external relative path preview annotations;
  the stronger team-portability warning fires only under
  `target = "project" ∧ source under home ∧ source not under project`, and a
  paired assertion confirms it does **not** fire for an in-project source (even
  when the project is under the home directory) nor for a global target;
- exact canonical-equivalence deduplication between existing absolute and
  generated relative configured paths, with no duplication or reordering;
- settings preservation of unrelated keys, existing source paths, custom
  patterns, and `!`/`+`/`-` entries;
- preview annotations for existing rule-disabled selected skills;
- name collision winner and shadowed result using Pi-compatible precedence;
- unknown/expired/consumed/cross-owner/cross-workspace source IDs, stale scan
  revision, stale candidate ID, source disappearance, untrusted project,
  malformed JSON, non-object settings, lock/atomic-write failure, and
  no-write-on-revalidation-failure behavior;
- a new descendant added to a completely selected group after preview makes the
  revision stale and writes nothing, while descendants added after a successful
  group-path install are discovered by a later fresh Pi runtime;
- all missing entries added in one atomic mutation and repeat install idempotent.

### Native and authorization tests

Add tests for folder-picker command authorization and cancellation, registry
TTL/revocation/single-use behavior, window and workspace-generation binding,
app/Pi restart invalidation, and replacement-selection revocation. Test that
non-owner, LAN/mobile, authenticated-owner ephemeral, and temporary-chat
contexts cannot invoke picker, registry resolution, scanning, or installation.
Verify browser payload paths cannot replace the host-selected source and a
handle cannot be replayed across windows or workspaces.

### Frontend tests

Add jsdom coverage for:

- Discovered / Install / Packages skills tab switching;
- empty scan and scan diagnostics;
- group checkbox selection, child deselection, and indeterminate state;
- complete vs partial group preview;
- global/project scope switch and untrusted-project disabled state;
- exact preview entries, existing configured skip labels, disabled-by-rule and
  shadowed labels;
- final confirmation content including skill metadata, full paths, script risk,
  and restart requirement;
- pending install control, successful in-place completion state, and inline
  error retaining the prior selection;
- English/Chinese locale completeness.

### Release checks

After implementation run:

```bash
bun run check
bun run build:extensions
bun run check:rust
bun run test
```

Perform a desktop smoke test on macOS:

1. Open Settings > Skills > Install and select a directory in Finder.
2. Select a full group, choose Global, verify its future-descendant warning,
   confirm, inspect the minimal global `settings.json` addition, start a fresh
   Pi session, and confirm `/skill:<name>` or `list_skills` resolves each
   newly linked relative path.
3. Select part of a second group, choose a trusted project, verify individual
   paths rather than its group path, confirm, start a fresh project Pi session,
   and confirm `/skill:<name>` or `list_skills` resolves each newly linked
   relative path.
4. Repeat either installation and confirm canonical-equivalent entries are
   skipped without duplicating configuration.
5. Add an existing exclusion and a same-name skill, then verify the preview
   shows the disabled/shadowed result without rewriting the existing rules.

## Architecture Update

Implementation must update `ARCHITECTURE.md` in the same change to document the
three-tab Skills IA, the Rust-host-owned opaque source-handle registry and
internal broker resolution lifecycle, owner/workspace-generation binding and
revocation, link-install scan/revision/atomic mutation lifecycle, scope/trust
boundaries, display-only path disclosure, and the rule that selected source
paths never become browser mutation authority.

## Follow-up Work

Project-level raw Configuration editing, dedicated linked-skill removal,
installation provenance, copy installation, update checks, and other harness
marketplaces are deliberately separate product decisions. They must not be
silently folded into this feature.
