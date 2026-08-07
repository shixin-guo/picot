# Package Skills Tab Design

## Status

Approved in discussion with Dr. Lin on 2026-07-27; scope clarified on
2026-07-29. This document extends:

- [`2026-07-24-skills-page-design.md`](2026-07-24-skills-page-design.md),
  which intentionally excluded package-provided skills from the first
  inventory; and
- [`2026-07-27-skill-link-installation-design.md`](2026-07-27-skill-link-installation-design.md),
  which adds the link-install workflow.

Where the earlier documents describe two inner Skills tabs, this document
extends the final information architecture to three tabs. The first version is
a read-only inventory of bundled skill candidates from configured packages; an
enable/disable design is retained as a future extension (see
[Future extension: package skill enable/disable](#future-extension-package-skill-enabledisable)).

## Problem

Pi packages can bundle extensions, skills, prompts, and themes. A configured
package declares resources through `package.json` `pi` manifest entries or Pi's
conventional resource directories. For example, the installed
`npm:context-mode` package is configured in global `settings.json`, resolves to
`~/.pi/agent/npm/node_modules/context-mode/`, declares `pi.skills: ["./skills"]`,
and contains several `SKILL.md` files.

Picot's current Skills inventory intentionally mirrors only Pi's top-level
skill roots and top-level `settings.json.skills` entries. It does not show
skills declared by `settings.json.packages`, so users cannot inspect the
package-bundled skill resources and their provenance in the Skills Settings
page. Because the first version deliberately does not evaluate user package
filters or name shadowing, it does not describe this list as the active command
set.

## Goal

Add a read-only **Packages skills** inner tab to Settings > Skills. It lists
Pi-compatible bundled skill candidates from configured packages, with package
provenance and source paths. It does not compute enabled/disabled state, filter effects, or name
shadowing in the first version; the [future extension](#future-extension-package-skill-enabledisable)
section records the design for that capability.

The tab is an accurate inventory surface. It must not change `settings.json`,
`packages[]`, a package manifest, or a `SKILL.md` file in this version.

## Product Decisions

| Concern | Decision |
| --- | --- |
| Skills page tabs | Settings > Skills contains **Discovered**, **Install**, and **Packages skills**. Discovered handles top-level and linked resources; Install adds top-level links; Packages skills is a distinct read-only inventory of bundled skill candidates from configured Pi packages. |
| Package source of truth | Discover only packages explicitly configured in global or trusted project `settings.json.packages[]`. Never discover packages solely by walking installed directories. |
| Supported sources | Resolve configured npm, git, and local package sources to their installed directory using Pi-compatible source parsing and scope-aware install roots (see [Package source resolution](#package-source-resolution)). |
| Package resource declaration | Use non-empty `package.json.pi.skills` entries to construct the manifest-allowed skill candidate set. When the property is absent or empty, use Pi's conventional `<packageRoot>/skills/` candidate directory. This is candidate inventory, not a claim that every item is enabled by the configured package entry. |
| Skill discovery | Mirror Pi's `collectManifestFiles` candidate-set algorithm: collect direct files, directories, and globs from non-override `pi.skills` entries, apply manifest `!`/`+`/`-` patterns against the package root, then parse the resulting `SKILL.md` files with shared skill parsing/discovery helpers. Use conventional `<packageRoot>/skills/` recursive discovery when `pi.skills` is absent or empty. |
| Skill status | The first version lists only the skill's frontmatter name, description, and canonical source path. It does not show enabled/disabled, filtered, or shadowed status, because no filter evaluation is performed. |
| Mutation | Read-only. No skills switch, package filter editor, settings writer, package installer, package updater, or reload action is provided in this version. The enable/disable capability is retained as a future extension. |
| Scope and trust | Global configured packages are shown. Project packages are shown only when the project is trusted. An untrusted project shows a trust explanation and does not expose project package host paths. |
| Runtime state | The tab reports the persisted `packages[]` configuration. It does not claim an existing Pi process has reloaded resources. |

## Pi Compatibility Contract

### Package roots are not auto-discovery directories

Pi resolves packages through its package manager, not through top-level
auto-discovery. Therefore Picot must not scan either of these directories as a
generic source of skills:

```text
~/.pi/agent/extensions/
~/.pi/agent/npm/node_modules/
```

The first contains ordinary auto-discovered extension files, not package roots.
The second contains configured package roots plus arbitrary transitive npm
dependencies. A filesystem-only sweep would display dependencies, stale package
installations, and package resources absent from `settings.json.packages[]`.

The required resolution pipeline is:

```text
global settings.json packages[]
trusted project .pi/settings.json packages[]
  └─ package identity dedupe + autoload:false delta-base resolution
       └─ source → installed package root resolution (npm / git / local)
            ├─ non-empty pi.skills candidate entries + manifest overrides
            └─ conventional skills/ discovery when pi.skills is absent or empty
```

### Package source resolution

Resolve each effective configured package source to its installed directory
with bounded Pi-compatible source parsing and package-identity resolution. No
npm/git subprocess or installation/reconciliation operation is permitted. The
module need not instantiate `DefaultPackageManager`, but it must mirror the
read-side identity, scope precedence, and `autoload: false` delta-base behavior
specified below before applying the deterministic install-root transform.

| source | installed directory |
| --- | --- |
| `npm:<name>[@version]`, global | `~/.pi/agent/npm/node_modules/<name>` |
| `npm:<name>[@version]`, trusted project | `<cwd>/.pi/npm/node_modules/<name>` |
| `git:<host>/<path>[@ref]`, global | `~/.pi/agent/git/<host>/<path>` |
| `git:<host>/<path>[@ref]`, trusted project | `<cwd>/.pi/git/<host>/<path>` |
| local path | resolved relative to the effective source scope's settings base; an `autoload:false` project delta matching a global local package inherits the global source and global base |

Before applying this table, construct package entries in Pi order (trusted
project entries first, then global entries) and deduplicate by Pi package
identity: npm package name without version, normalized git host/path without
ref, or canonical local path resolved against the declaring scope base. A
normal project entry wins over a matching global entry. A project object with
`autoload: false` is retained as a delta alongside its matching global entry;
for that delta, use the matching global entry's source string, scope, and
installed root while retaining project provenance for display. A delta without
a matching global identity resolves from its own project source/root, matching
Pi's fallback behavior. This read-side root resolution is required in the
first version even though filter status remains deferred.

Notes:

- The version portion of an npm spec and the ref portion of a git spec do not
  affect the install path; only `<name>` and `<host>/<path>` select it.
- Git `host`/`path` normalization must match Pi's `parseGitUrl` for the SSH,
  HTTPS, and shorthand forms Pi accepts. **Source the normalizer from
  `@earendil-works/pi-coding-agent`'s `utils/git.ts` rather than reimplementing
  it.** Picot already depends on that package (`bun.lock`), and its bundled
  sourcemap (`dist/utils/git.js.map` → `sourcesContent`) carries the
  authoritative implementation; the npm-resolved module exports `parseGitUrl`
  directly. The resolution table above is authoritative for the directory
  layout; the imported normalizer is the bounded utility that feeds it. A
  contract test must assert Picot's resolved `host`/`path` for SSH, HTTPS, and
  shorthand fixtures equals Pi's `parseGitUrl` output for the same inputs, so
  an upstream Pi change cannot silently drift.
- A package source whose resolved directory does not exist (not yet installed,
  failed install, removed) is reported as a package-level diagnostic, not
  silently dropped. The user can see that they configured a package that is not
  currently on disk.

### Skill resource candidate set

For each resolved package root, mirror Pi's package-manifest collection
semantics rather than treating every manifest entry as a directory:

1. Read `package.json` as an object and distinguish a valid `pi` manifest, no
   `pi` manifest (including an absent `package.json`), and malformed JSON or
   manifest data. Malformed data is a package-level diagnostic and must not
   crash inventory construction. As Pi's read helper treats an unreadable
   manifest as absent, candidate discovery may still use the conventional
   directory while retaining Picot's diagnostic.
2. If `package.json.pi.skills` is an array, partition its entries into source
   entries and override entries. Source entries are strings not beginning with
   `!`, `+`, or `-`; each may identify a direct Markdown file, a directory, or
   a glob relative to the package root.
3. Expand source-entry globs with Pi-compatible `cwd`, absolute, `dot: false`,
   and file/directory behavior. Feed the resulting paths into the shared skill
   collector: directories use recursive `SKILL.md` discovery with the normal
   stop-under-skill, hidden, `node_modules`, ignore-file, symlink, and
   frontmatter behavior; direct Markdown files are parsed as explicit skills.
4. Apply the manifest's `!`, `+`, and `-` override entries to the collected
   canonical skill-file set using the package root as `baseDir`, with Pi's
   include/exclude/exact precedence. Only manifest-allowed skill files are
   listed. Multiple source roots and mixed file/directory/glob declarations are
   valid and canonical duplicates collapse to one item.
5. If `pi.skills` is absent or an empty array, recursively discover the
   conventional `<packageRoot>/skills/` directory with the shared `mode: "pi"`
   routine, matching Pi's `collectManifestFiles` candidate-universe behavior.
   Whether the configured package entry ultimately autoloads, filters, or
   disables those candidates is deliberately not presented as status in this
   version.

This version does not evaluate the user-owned `packages[].skills` filter. A
skill in the Pi-compatible package candidate universe is listed whether or not
the configured package entry would currently enable it. Manifest overrides are
still evaluated because they bound that universe before user filters layer on
top. The tab consistently labels the result as **bundled candidates**, never as
the active resource or command set. The
[future extension](#future-extension-package-skill-enabledisable) preserves the
separate design for computing and mutating user filter state.

## User Experience

### Tabs and scope

The existing Settings > Skills page uses its current shell, theme tokens,
localization, and responsive behavior. Its inner navigation becomes:

```text
Skills
├─ Discovered        Top-level and linked skills; existing controls
├─ Install           Explicit top-level link installation workflow
└─ Packages skills   Read-only bundled candidates from configured packages
```

Packages skills has Global and Current project scope controls consistent with
the rest of the Skills page. The selected scope determines which package
settings entries are emphasized and which count is displayed.

When the project is untrusted, the project control communicates that Pi does
not load project packages. It does not expose project package roots, skill
paths, or package diagnostics as active resources.

### Package cards

Each configured, resolved package with package skill candidates renders one
expandable card. The card header shows:

- package source, such as `npm:context-mode` or a git/local source;
- scope: Global or Current project;
- resolved package version when readable from `package.json`;
- total bundled-candidate skill count;
- package-level diagnostics, if any (including "not installed" when the
  resolved directory is absent).

The card must identify this source as **Package-managed**, **Bundled
candidates**, and read-only; it must not imply that each row is enabled or has
registered a command. A
package that is configured but supplies no skills appears only in a compact
empty/diagnostic presentation; it must not be fabricated into a skills card.

### Skill rows

Each row uses DOM text rendering and shows:

- frontmatter `name` and `description`;
- relative resource path inside the package and full canonical path in a
  tooltip or accessible label;
- a read-only explanation that these are package candidates and effective
  resource/command state is not shown or edited in this version.

No toggle, install button, delete action, raw filter editor, status badge, or
settings mutation appears on package cards.

## Architecture

```text
Settings > Skills > Packages skills (desktop owner)
  └─ authenticated loopback owner-only WebSocket RPC
       └─ embedded-server package skill inventory command
            └─ pure source-resolution + shared skill-discovery module
                 ├─ global settings.json packages[]
                 └─ trusted project .pi/settings.json packages[]
```

### Pure inventory module

Create a focused testable module, for example
`extensions/package-skill-inventory.ts`. It owns:

- global and trusted-project settings `packages[]` reads;
- Pi-compatible package identity dedupe and project `autoload:false` delta-base
  inheritance before source → installed-package-root resolution;
- npm, git, and local effective-source resolution using the bounded transform in
  the [resolution table](#package-source-resolution);
- package manifest source-entry expansion, manifest override evaluation, and
  conventional-directory fallback;
- shared collection/parsing helpers for direct skill files and recursively
  discovered directories — it does not reimplement frontmatter or recursive
  skill-discovery rules;
- package provenance metadata and stable IDs based on package identity plus
  canonical resource path;
- per-package and per-item diagnostics (malformed manifest, unreadable skill
  file, absent install directory).

It is read-only: it exports no settings mutation/write API.

A suggested response shape is:

```ts
type PackageSkillInventory = {
  scope: "global" | "project";
  trusted: boolean;
  packages: Array<{
    id: string;
    source: string;
    scope: "global" | "project";
    packageRoot?: string;
    version?: string;
    skills: Array<{
      id: string;
      canonicalPath: string;
      relativePath: string;
      name: string;
      description: string;
      diagnostic?: string;
    }>;
    diagnostics: Array<{ path?: string; message: string }>;
  }>;
  diagnostics: Array<{ path?: string; message: string }>;
};
```

The final implementation may refine names, but it must preserve package source,
scope, canonical resource identity, and read-only status.

### Embedded server

`extensions/embedded-server.ts` remains the transport adapter. Add one
loopback desktop-owner-only command:

```ts
list_package_skill_inventory { scope: "global" | "project" }
```

Its parser accepts only the closed scope set. The handler derives `cwd`, agent
directory, home directory, and project trust exclusively from retained host or
extension context. It calls the pure read-only inventory builder and returns
the result.

Add the command to the existing desktop-owner command policy plus an explicit
non-ephemeral gate. The current `desktopOwnerOnly` classification by itself can
admit an authenticated desktop owner in the ephemeral server path; that path,
temporary chat, LAN, and mobile clients must still be rejected because the
result contains host package paths and metadata.

### Frontend

Extend `public/settings/skills-page.js`, or extract a dedicated focused
package-skills-tab module. It owns package inventory load state, selected scope,
card expansion state, loading/error/empty displays, and locale rerendering.
`public/app.js` only wires activation and the authenticated RPC command.

Use DOM APIs and `textContent` for package and skill metadata. Add English and
Chinese locale keys for Package-managed labels, diagnostics, the read-only
notice, and trust state. Existing locale completeness tests remain green.

## Future extension: package skill enable/disable

This section records the design for a future version that enables or disables
individual skills bundled by a configured package. It is **not implemented in
this version**. The read-only inventory above is the foundation for it.

### What changes

Toggling a package skill edits the user's own Pi settings file —
`~/.pi/agent/settings.json` for global scope, or `<cwd>/.pi/settings.json` for
trusted-project scope — not any file inside the package installation
directory. `pi update`, `npm install`, and package reconciliation never touch
the user's settings file, so an enable/disable entry is never overwritten by a
package update.

The mechanism, confirmed against Pi's `config-selector.ts`
`togglePackageResource`, is:

1. Locate the matching entry in `packages[]` by source.
2. If the entry is a bare string (for example `"npm:context-mode"`), promote it
   to object form `{ "source": "npm:context-mode" }`.
3. Append a `+`/`-` rule to that object's `skills` array:

   ```json
   {
     "source": "npm:context-mode",
     "skills": ["-skills/review/legacy"]
   }
   ```

4. Rule paths are **package-root-relative**. The pattern for a resolved skill
   resource is `relative(packageRoot, skillFile)`, including the file name when
   the resource path is the skill file—for example
   `skills/review/SKILL.md`. Pi's exact matcher also recognizes a deliberately
   generated parent skill-directory path such as `skills/review`, but the
   implementation must choose one representation explicitly and test it rather
   than dropping `/SKILL.md` accidentally. The inventory retains both the
   canonical skill-file path and its package-root-relative representation.
5. Rule semantics (`!` glob, `+` exact force-include, `-` exact force-exclude)
   are the same `!`/`+`/`-` grammar already implemented for top-level skills in
   `skill-inventory.ts`. The only differences are the base directory
   (packageRoot) and the target array (`packages[].skills` instead of the
   top-level `skills[]`).

### Read-side prerequisite

Because the write path relies on the rule grammar, a future enable/disable
version will first extend the read-only inventory to evaluate
`packages[].skills` filters and report each skill's effective enabled/disabled
state, reusing the existing `isEnabledByOverrides` / `buildMatchContext`
helpers from `skill-inventory.ts`. User-filter delta evaluation and same-name
shadowing against top-level resources remain part of that future read-side
extension. Package identity dedupe and `autoload:false` **source/root
inheritance** are already required by the current read-only version so it reads
the correct installed package; only per-path enabled/disabled delta state is
deferred.

### Why deferred

- Package filter globs are package-root-relative and therefore fragile against
  package-internal reorganization: if a later package version renames or moves
  a skill directory, a previously configured `-skills/review/**` may silently
  misfire or mis-target. Surfacing this risk well needs more design than a
  toggle alone.
- The marginal value is low today: users can already edit `packages[]` in the
  raw Configuration editor, and the read-only inventory already shows which
  skills a package bundles.
- The read-only inventory is delivered first so the eventual write path has a
  verified state source to display.

The future extension must not be silently folded into the read-only feature.
It requires its own design pass and its own ARCHITECTURE.md update when taken
on.

## Security and Persistence Invariants

- The tab performs no writes to global or project settings files.
- It does not mutate `packages[]`, package filters, package manifests, package
  installation directories, or any `SKILL.md` content.
- It inspects only package roots reachable from configured package entries;
  it never inventory-scans arbitrary `npm/node_modules`, `git`, or `extensions`
  directories.
- Package paths, source metadata, and diagnostics remain available only through
  the authenticated desktop-owner loopback route.
- Project package discovery is trust-gated exactly as Pi is.
- The tab reports persisted configuration resolution, not unsupported live
  reloading of an already running Pi process.

## Verification

### Pure module tests

Add deterministic fixtures for:

- global npm source resolving to
  `<agentDir>/npm/node_modules/<package-name>`;
- trusted project npm source resolving to
  `<cwd>/.pi/npm/node_modules/<package-name>`;
- global and trusted project git source roots; git source parser contract
  test asserting Picot's resolved `host`/`path` for SSH, HTTPS, and shorthand
  fixtures equals `@earendil-works/pi-coding-agent`'s `parseGitUrl` output for
  the same inputs (the normalizer is imported from that package, not
  reimplemented);
- global/project local package paths resolved relative to their respective
  settings bases;
- package identity dedupe where project wins, matching project
  `autoload:false` delta uses the global source/install root, unmatched delta
  falls back to its project root, and local identities resolve against the
  correct scope base;
- `package.json.pi.skills` direct files, multiple directories, mixed globs,
  canonical duplicate matches, and manifest `!`/`+`/`-` candidate overrides;
- absent or explicitly empty `pi.skills` uses conventional `skills/` candidate
  fallback, without claiming those candidates are enabled by user filters;
- shared recursive discovery semantics: stop-under-`SKILL.md`, hidden and
  `node_modules` exclusions, ignore files, symlink canonicalization, malformed
  frontmatter, and unreadable skill files become per-item diagnostics;
- malformed or missing manifest with/without a conventional skills directory,
  and absent/stale package install roots become package-level diagnostics where
  applicable without terminating other package entries;
- the installed `context-mode` layout shape: manifest `./skills`, several
  `SKILL.md` files listed by the read-only inventory.

### Embedded-server and command-policy tests

Add parser tests for valid global/project `list_package_skill_inventory` scope
and reject all other payloads. Add command-policy and handler coverage that the
command is desktop-owner-only and unavailable to authenticated-owner ephemeral,
LAN/mobile, non-owner, and temporary-chat execution paths.

### Frontend tests

Add jsdom coverage for:

- three inner tabs and Packages skills activation;
- grouped package cards with source, scope, version, and bundled-candidate
  skill count;
- skill rows showing name, description, and canonical path only (no status
  badge, no toggle);
- empty package and diagnostic states, including "not installed";
- Global/Current project selection and the untrusted-project warning;
- no editable control or mutation RPC on any package skill row/card;
- loading, inline failure, card expansion, and locale rerendering;
- English/Chinese locale completeness.

### Architecture update

Implementation must update `ARCHITECTURE.md` in the same change to document the
three-tab Skills IA, the read-only configured-package resolver module, the
package source-resolution compatibility boundary, project trust gating, and the
owner-only package-inventory transport.

### Release checks

After implementation run:

```bash
bun run check
bun run build:extensions
bun run test
```

Perform a desktop smoke test with global `npm:context-mode` installed:

1. Open Settings > Skills > Packages skills.
2. Confirm the `npm:context-mode` Global card lists the package skills from its
   manifest-declared `skills/` root.
3. Confirm package version, bundled-candidate count, source, Package-managed
   label, and the notice that effective state is not shown are present.
4. Confirm no toggle, status badge, or mutation control appears on any skill
   row or package card.

## Non-goals (this version)

- Enabling, disabling, or filtering package skills from the Skills page (see
  the [future extension](#future-extension-package-skill-enabledisable));
- computing or displaying enabled/disabled, filtered, or shadowed status for
  package skills;
- writing `settings.json` or mutating `packages[]` / `packages[].skills`;
- editing package manifests, package files, or `SKILL.md` content;
- listing extensions, prompts, or themes supplied by a package in this tab;
- showing packages absent from configured global/trusted-project `packages[]`;
- full filesystem scans of `~/.pi/agent/extensions/`,
  `~/.pi/agent/npm/node_modules/`, or `~/.pi/agent/git/`;
- reloading a currently running Pi process;
- exposing package paths or inventory to LAN/mobile/temporary/ephemeral clients.
