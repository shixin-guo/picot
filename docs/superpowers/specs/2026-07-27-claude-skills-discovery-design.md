# Claude Code Skills Discovery and Enablement Design

## Status

Proposed after discussion with Dr. Lin on 2026-07-27. This document extends
[`2026-07-24-skills-page-design.md`](2026-07-24-skills-page-design.md). The
final Skills information architecture is the three-tab model in
[`2026-07-27-package-skills-tab-design.md`](2026-07-27-package-skills-tab-design.md):
**Discovered**, **Install**, and **Packages skills**. Claude Code compatible
roots and their enable control belong in **Discovered**. Where this document
conflicts with the earlier Skills page design, this document controls for
Claude Code skill roots.

## Problem

A workspace may contain `<cwd>/.claude/skills/` without a `.pi/` or
`.agents/` directory. Picot's current skill inventory mirrors Pi's automatic
roots, which do not include `.claude/skills`; therefore the Skills page does
not show those skills.

This is an inventory gap, not a Pi limitation. Pi 0.82.0 documents Claude
Code / Codex interoperability as an explicit configuration mechanism
(`src-tauri/resources/pi/docs/skills.md`, "Using Skills from Other
Harnesses"): add `~/.claude/skills` or `~/.codex/skills` to the `skills`
array in settings. Pi deliberately does not auto-discover these roots,
because cross-harness loading is an owner opt-in. Picot extends only its
**inventory** with the Claude roots so the desktop owner can see them and
explicitly enable them; it does not claim Pi auto-loads them. Showing a
Claude root in Picot's inventory must not falsely claim that the current or
next Pi process will load it before that documented plain-path entry is
configured.

## Goal

Let desktop owners discover compatible Claude Code skills in the Settings >
Skills inventory and explicitly enable those roots for Pi with a minimal,
atomic, idempotent settings mutation.

## Product Decisions

| Concern | Decision |
| --- | --- |
| Claude roots discovered by Picot | Global `~/.claude/skills/`; project `<cwd>/.claude/skills/`, only after the project is trusted. |
| Discovery ownership | Claude roots are Picot inventory extensions, not Pi automatic discovery roots. They are visibly identified as Claude Code compatible roots. |
| Pi runtime enablement | Pi receives the roots only through an explicit plain-path entry in its `skills` settings array. Merely discovering a root never enables it. |
| Configuration write | Never silently write `settings.json`. The desktop owner must use an explicit enable action that previews the exact target file and entry. |
| Global entry | In `~/.pi/agent/settings.json`, append `../../.claude/skills` when absent. This is POSIX-relative to the Pi global resource base `~/.pi/agent/`. |
| Project entry | In `<cwd>/.pi/settings.json`, append `../.claude/skills` when absent. This is POSIX-relative to the Pi project resource base `<cwd>/.pi/`. |
| Repeated enable | Idempotent by canonical identity: resolve every existing ordinary plain-path entry against the selected scope's Pi settings base, canonicalize it, and treat any entry resolving to the Claude root as already configured. Preserve its original text and order; do not append a second representation. |
| Disable | This version deliberately does not remove a user-approved Claude root plain path. Removing a shared plain path can affect every skill discovered below that root and must not be inferred from an individual row. The existing Configuration editor remains the explicit escape hatch until a separately designed root-removal flow exists. Per-skill and per-group `!`/`+`/`-` controls continue to apply after the root is enabled. |
| Runtime application | Every successful enable reports `runtimeRestartRequired: true`; the change affects only a new session or restarted Pi process. |
| Trust | A project Claude root and its enable action remain unavailable until `ctx.isProjectTrusted()` is true. Global enablement remains desktop-owner-only. |
| Other harnesses | Only `.claude/skills` is an inventory extension root. `.codex/skills` and every other harness-specific root (including other `.claude/*` subdirectories such as `.claude/agents` or `.claude/extensions`) is out of scope and never auto-discovered. |

## Pi Compatibility Contract

The embedded Pi 0.82.0 skill documentation defines automatic global roots as
`~/.pi/agent/skills/` and `~/.agents/skills/`, and automatic project roots as
`.pi/skills/` plus ancestor `.agents/skills/`. It documents Claude Code
interoperability through explicit entries in `settings.json`; it does not
perform automatic `.claude/skills` discovery.

Picot extends only its **inventory** with the two Claude roots. Pi runtime
loading remains Pi-compatible because the explicit enable operation writes the
same plain relative paths Pi documents and resolves.

### Claude-root discovery rules

Claude roots use the existing `.agents`-style discovery mode:

- discover a skill when a directory contains `SKILL.md`;
- traverse recursively until finding that `SKILL.md`, then do not traverse
  below that skill directory;
- ignore root-level loose Markdown files;
- ignore hidden directories and `node_modules`;
- honor `.gitignore`, `.ignore`, and `.fdignore` through the existing matcher;
- canonicalize symlink targets and deduplicate canonical `SKILL.md` paths;
- retain malformed or unreadable files as per-item diagnostics rather than
  failing the entire inventory.

Claude roots have two distinct path bases that must not be conflated:

- the **discovery base** is `<cwd>/.claude/` or `~/.claude/`; it is used only
  to group and label inventory rows beneath the Claude root;
- the **Pi rule base** is the directory containing the target Pi settings file:
  `<cwd>/.pi/` for project settings and `~/.pi/agent/` for global settings.
  Pi evaluates every top-level `skills[]` `!`, `+`, and `-` entry against that
  scope base, including rules for a plain path that points outside `.pi`.

All generated settings rules therefore use portable POSIX paths relative to the
Pi rule base. The browser may display discovery-relative paths but must not use
them as settings-rule authority.

### Rule semantics

The existing Pi-compatible `!`, `+`, and `-` evaluation is unchanged. A
Claude-root rule must serialize the target relative to the settings scope's Pi
rule base. For example, a group at `<cwd>/.claude/skills/review/` uses:

```json
{
  "skills": ["../.claude/skills", "!../.claude/skills/review/**"]
}
```

An exact child override uses, for example,
`+../.claude/skills/review/security`. Global Claude rules analogously begin
with `../../.claude/skills/` because Pi evaluates global top-level rules against
`~/.pi/agent/`. The plain root entry causes Pi to collect candidates; the
scope-base-relative rules then determine their effective state. No
Claude-specific rule grammar or `.claude`-relative evaluation is introduced.

Claude roots participate in canonical-path deduplication, name-shadowing, and
cross-root ambiguity detection. An ambiguous item or group remains read-only;
Picot must never write a rule that could modify more than one root.

## User Experience

### Root state

When Picot discovers a Claude root, its card in the **Discovered** tab
identifies it as a **Claude Code compatible root**. The page distinguishes two states:

1. **Discovered, not enabled for Pi:** the directory was found but no ordinary
   plain-path entry in the relevant settings `skills` array resolves and
   canonicalizes to that root. The Skills page may show metadata, diagnostics,
   and the root path, but must not present it as active in Pi.
2. **Enabled for Pi:** a canonical-equivalent ordinary plain path is present in
   the relevant settings. Its stored spelling may be the recommended relative
   entry, another relative representation, or an absolute path. The normal
   effective-state inventory and group/skill controls are available; a
   successful mutation still requires a new Pi runtime.

### Explicit enable action

For each discovered, unconfigured root that belongs to the selected scope, the
Skills page presents an explicit action such as **Enable Claude Code skills in
Pi**. Before the mutation, it shows:

- the source directory;
- the exact settings file to modify;
- the exact POSIX entry to append;
- that the action applies only after a new session or Pi restart.

The action is disabled for an untrusted project and retains the existing trust
warning. It is unavailable to LAN/mobile/temporary-chat clients.

After a successful response, the page replaces its server-backed inventory and
shows the existing restart-required success treatment. A failed response keeps
the previous inventory and presents the server error inline.

There is no automatic prompt suppression record in this version: the action is
shown whenever a discovered root remains unconfigured. The user can leave it
unconfigured without Picot creating state or modifying a file.

## Architecture

```text
Settings > Skills (desktop-owner browser)
  └─ authenticated owner-only WebSocket RPC
       └─ embedded-server Claude-root enable command
            ├─ validates scope, trust, and requested known Claude root
            ├─ invokes skill-inventory pure settings helper
            │    └─ atomic read / patch / write under Pi-compatible lock
            └─ recomputes and returns the complete inventory
```

### `extensions/skill-inventory.ts`

Extend the existing pure inventory module with:

- Claude global and trusted-project discovery roots, using the `.agents`-style
  recursive mode, a `.claude` discovery base, and the selected settings scope's
  distinct Pi rule base;
- inventory metadata sufficient for the frontend to tell whether an ordinary
  configured path resolves canonically to a discovered Claude root;
- a pure helper to resolve the requested root entry by scope:
  - global: `../../.claude/skills`;
  - project: `../.claude/skills`;
- an atomic mutation helper that reads the latest JSON object, preserves every
  unrelated key and unmanaged `skills` entry, resolves existing ordinary paths
  against the scope's Pi base, appends the recommended root entry only when no
  canonical-equivalent entry exists, writes through the existing settings lock
  and atomic replacement, and returns a freshly recomputed inventory.

The helper rejects an unknown root, a root not belonging to the selected scope,
a missing/disappeared root, an untrusted project, malformed JSON, and a
non-object settings file. It must not accept a browser-supplied filesystem path
as authority.

### `extensions/embedded-server.ts`

Add an owner-only command, for example:

```ts
skill_add_root {
  scope: "global" | "project",
  kind: "claude-global" | "claude-project"
}
```

The parser validates the closed scope/kind set. The handler derives `cwd`,
`agentDir`, and project trust only from its retained extension context, calls
the inventory mutation helper, and returns:

```ts
{
  inventory: SkillInventory,
  runtimeRestartRequired: true
}
```

Add the command to the existing command policy as desktop-owner-only and add an
explicit non-ephemeral gate: the current `desktopOwnerOnly` classification by
itself permits an authenticated desktop owner inside the ephemeral server path.
The handler must reject ephemeral/temporary-chat runtimes even for that owner,
and remain unavailable through LAN or mobile paths.

### `public/settings/skills-page.js`

Add a small root-level enable control using only the server inventory metadata.
It sends the closed `skill_add_root` request, disables only its affected action
while pending, and re-renders from the returned inventory. It must render
metadata via DOM text nodes, not HTML interpolation.

Add English and Chinese locale keys for root identity, enable action, preview,
trust restriction, errors, and restart-required success. The page does not
perform path resolution or derive whether Pi enables a root locally.

## Persistence and Safety Invariants

- No discovery or rescan path writes a settings file.
- Only an explicit desktop-owner enable request may write the corresponding
  scope's settings file.
- The writer always reads the current settings object while holding the
  Pi-compatible `${settingsPath}.lock` directory lock.
- Writes preserve unrelated keys, existing plain paths, custom patterns, and
  `!`/`+`/`-` rules; the only allowed delta is the recommended Claude root
  plain-path entry when no canonical-equivalent ordinary entry exists.
- The mutation is idempotent by canonical root identity and must not rewrite,
  reorder, or duplicate an existing equivalent entry.
- All settings paths and enabled root entries use portable POSIX serialization.
- A successful write never claims the currently running Pi process reloaded its
  resources.

## Verification

### Pure inventory and mutation tests

Add deterministic `extensions/skill-inventory.test.ts` coverage for:

- global `~/.claude/skills/` and trusted project `<cwd>/.claude/skills/`
  discovery, including projects with no `.pi/` and no `.agents/` directory;
- project trust gating: untrusted projects expose neither discovered Claude
  skills nor an enabled mutation target;
- recursive `SKILL.md` detection, nested-skill traversal termination, ignored
  root-level loose Markdown, hidden directories, `node_modules`, ignore-file
  exclusions, symlink canonicalization, and malformed frontmatter diagnostics;
- exact resource bases and POSIX plain entries:
  `../../.claude/skills` globally and `../.claude/skills` for projects;
- generated group and item rule paths relative to `<cwd>/.pi/` or
  `~/.pi/agent/`, with real Pi tests proving `.claude`-relative patterns do not
  accidentally become the contract;
- idempotent enable with exact, alternate-relative, absolute, and symlink-alias
  canonical-equivalent existing entries, preservation of their original text
  plus unrelated settings keys and unmanaged `skills` entries, and no
  reordering;
- atomic-write failure, malformed/non-object settings, unknown kind/scope,
  untrusted project, and root disappearance races;
- persisted global and project relative root entries loaded by a fresh real Pi
  runtime, verified through `/skill:<name>` or `list_skills`;
- canonical collision, name shadowing, and cross-root ambiguity involving
  `.claude`, `.pi`, and `.agents` roots.

### Embedded server tests

Extend `extensions/embedded-server-skills.test.ts` for valid and invalid
`skill_add_root` parser inputs. Extend `extensions/command-policy.test.ts` to
assert the command is desktop-owner-only and rejected in authenticated-owner
ephemeral/temporary-chat mode as well as non-owner and remote paths.

### Frontend tests

Extend `public/settings/skills-page.test.js` for:

- discovered-but-unconfigured Claude-root label and explicit enable action;
- previewed target settings path and exact entry text;
- pending action state;
- re-render from the successful server inventory;
- inline error without corrupting prior state;
- disabled action and trust warning for an untrusted project;
- English/Chinese locale completeness.

### Architecture update

Implementation must update `ARCHITECTURE.md` in the same change to document the
three-tab Skills IA, Claude-compatible discovery roots in the Discovered tab,
the explicit owner-only root-enable mutation, settings ownership, and the
project trust / restart invariants.

### Release checks

After implementation run:

```bash
bun run check
bun run build:extensions
bun run test
```

Perform a desktop smoke test with a project containing only
`.claude/skills/<skill>/SKILL.md`: confirm it is shown as unconfigured, enable
it explicitly, inspect the minimally changed `<cwd>/.pi/settings.json`, start
a fresh Pi session, and confirm that Pi registers the skill command only in the
fresh runtime.

## Non-goals

- Silent configuration writes during scan, rescan, application startup, or
  page rendering;
- removing a user-approved Claude plain-path root through the Skills UI;
- editing, installing, deleting, or otherwise modifying `SKILL.md` content;
- automatic discovery or enablement of `.codex/skills` or other harness roots;
- reloading skills in an already running Pi process;
- exposing host paths or settings mutation controls to LAN/mobile/temporary
  chat clients.
