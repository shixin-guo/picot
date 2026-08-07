// ABOUTME: Discovers and resolves Pi skills for Picot's Settings > Skills inventory.
// ABOUTME: Mirrors the embedded Pi resource rules without exposing filesystem access to the browser.

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stat as asyncStat, mkdir, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { minimatch } from "minimatch";
import {
  canonicalizeExistingPath,
  discoverSkillsFromRoot as discoverSharedFromRoot,
  type DiscoveredSkill as SharedDiscoveredSkill,
  type SkillDiagnostic as SharedSkillDiagnostic,
  type SkillDiscoveryRoot as SharedSkillDiscoveryRoot,
  toPosixPath,
} from "./skill-discovery.ts";

// ── Public types ──────────────────────────────────────────────────────

export type SkillScope = "global" | "project";

export type SkillTarget = { kind: "group" | "skill"; id: string };

export type SkillStatus = "enabled" | "disabled" | "shadowed" | "invalid";

export type SkillInventoryItem = {
  kind: "skill";
  id: string;
  canonicalPath: string;
  name: string;
  description: string;
  enabled: boolean;
  status: SkillStatus;
  ruleBaseDir: string;
  ruleRelativeDir: string;
  /** skill dir relative to its sourceRoot dir, used to place it in the tree */
  treePath: string;
  sourceRoot: string;
  scope: "user" | "project";
  source: "auto" | "local";
  matchingRules: string[];
  ambiguous: boolean;
  shadowedBy?: { id: string; canonicalPath: string; name: string };
};

export type SkillGroupNode = {
  kind: "group";
  id: string;
  sourceRoot: string;
  ruleBaseDir: string;
  /** path relative to Pi's resource base, used to generate `!`/`+`/`-` rules */
  ruleBaseRelativePath: string;
  /** final path segment, used for sorting and display */
  name: string;
  scope: "user" | "project";
  source: "auto" | "local";
  state: "all-on" | "all-off" | "mixed";
  ambiguous: boolean;
  children: SkillChild[];
};

export type SkillChild = SkillInventoryItem | SkillGroupNode;

export type SkillRootKind = "pi" | "agents" | "configured" | "claude-global" | "claude-project";

export type SkillRoot = {
  sourceRoot: string;
  ruleBaseDir: string;
  scope: "user" | "project";
  source: "auto" | "local";
  rootKind?: SkillRootKind;
  configuredForPi?: boolean;
  recommendedEntry?: string;
  settingsPath?: string;
  children: SkillChild[];
};

export type SkillDiagnostic = { path?: string; message: string };

export type SkillInventory = {
  scope: SkillScope;
  settingsPath: string;
  trusted: boolean;
  roots: SkillRoot[];
  customRules: string[];
  discoveredRoots: string[];
  diagnostics: SkillDiagnostic[];
};

export type SkillMutationResult = {
  inventory: SkillInventory;
  runtimeRestartRequired: true;
};

export type BuildSkillInventoryOptions = {
  scope: SkillScope;
  cwd: string;
  agentDir: string;
  homeDir?: string;
  projectTrusted?: boolean;
};

export type MutateSkillEnabledOptions = {
  scope: SkillScope;
  cwd: string;
  agentDir: string;
  homeDir?: string;
  projectTrusted?: boolean;
  target: SkillTarget;
  enabled: boolean;
};

// ── Constants mirroring Pi ────────────────────────────────────────────

const CONFIG_DIR_NAME = ".pi";

/**
 * Internal discovery-root shape used by the inventory pipeline. The shared
 * `skill-discovery.ts` module owns the actual filesystem collection; this
 * type only carries the per-root metadata (scope/source) the inventory needs
 * to build rule contexts and resolve name precedence. `scope` is the
 * historical `"user" | "project"` spelling used by all inventory DTOs; the
 * adapter maps `"global"` from the shared module back to `"user"`.
 */
type DiscoveredRoot = {
  dir: string;
  mode: "pi" | "agents";
  baseDir: string;
  scope: "user" | "project";
  source: "auto" | "local";
};

type RawSkill = {
  canonicalPath: string;
  filePath: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
  isConfiguredFile: boolean;
  root: DiscoveredRoot;
};

// ── Shared-discovery adapter ──────────────────────────────────────────

/** Map an internal root's `"user"` scope to the shared module's `"global"`. */
function toSharedScope(scope: "user" | "project"): "global" | "project" {
  return scope === "user" ? "global" : "project";
}

/** Map a shared DiscoveredSkill back into the internal RawSkill pipeline. */
function adaptSharedSkill(s: SharedDiscoveredSkill): RawSkill {
  return {
    canonicalPath: s.canonicalPath,
    filePath: s.filePath,
    name: s.name,
    description: s.description,
    disableModelInvocation: s.disableModelInvocation,
    isConfiguredFile: s.isConfiguredFile,
    root: adaptSharedRoot(s.root),
  };
}

/** Map a shared SkillDiscoveryRoot back to the internal DiscoveredRoot shape. */
function adaptSharedRoot(r: SharedSkillDiscoveryRoot): DiscoveredRoot {
  return {
    dir: r.dir,
    mode: r.mode,
    baseDir: r.baseDir,
    scope: r.scope === "global" ? "user" : "project",
    source: r.source === "auto" || r.source === "local" ? r.source : "local",
  };
}

/**
 * Delegate to the shared discovery module and adapt results back into the
 * internal RawSkill pipeline. This preserves byte-compatible behavior with
 * the previous inline collector while letting package/install sources reuse
 * the same collector.
 */
function discoverSkillsFromRoot(root: DiscoveredRoot, diagnostics: SkillDiagnostic[]): RawSkill[] {
  const sharedRoot: SharedSkillDiscoveryRoot = {
    dir: root.dir,
    mode: root.mode,
    baseDir: root.baseDir,
    scope: toSharedScope(root.scope),
    source: root.source,
  };
  const sharedDiags: SharedSkillDiagnostic[] = diagnostics;
  return discoverSharedFromRoot(sharedRoot, sharedDiags).map(adaptSharedSkill);
}

function resolveLocal(input: string, baseDir: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function toPosix(p: string): string {
  return toPosixPath(p);
}

function basenamePosix(p: string): string {
  const parts = toPosixPath(p).split("/");
  return parts[parts.length - 1] || "";
}

// Pi resolves skill patterns with `minimatch`; reuse it so brace/extglob and
// `**` semantics match the embedded runtime exactly.
function globMatch(pattern: string, value: string): boolean {
  return minimatch(value, pattern);
}

// ── Settings loading & rule helpers ───────────────────────────────────

function isOverride(entry: string): boolean {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function isPlainGlob(entry: string): boolean {
  return !isOverride(entry) && (entry.includes("*") || entry.includes("?"));
}

function readSettingsSkills(settingsPath: string): {
  skills: string[];
  parseError?: string;
} {
  if (!existsSync(settingsPath)) return { skills: [] };
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf-8");
  } catch {
    return { skills: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "invalid JSON";
    return { skills: [], parseError: msg };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { skills: [], parseError: "settings must be a JSON object" };
  }
  const skills = (parsed as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return { skills: [] };
  return { skills: skills.filter((s): s is string => typeof s === "string") };
}

export function normalizeExactPattern(pattern: string): string {
  let p = pattern;
  if (p.startsWith("./") || p.startsWith(".\\")) p = p.slice(2);
  return toPosix(p);
}

export type MatchContext = {
  rel: string;
  abs: string;
  name: string;
  parentRel: string;
  parentAbs: string;
  parentName: string;
};

/**
 * Build a match context from an already-resolved base-relative skill directory.
 * Used during mutation, where the on-disk canonical path may differ from the
 * rule base (e.g. macOS /var → /private/var) and would break glob matching.
 */
function buildMatchContextFromRule(ruleRelativeDir: string, baseDir: string): MatchContext {
  const rel = `${ruleRelativeDir}/SKILL.md`;
  return {
    rel,
    abs: toPosix(join(baseDir, rel)),
    name: "SKILL.md",
    parentRel: ruleRelativeDir,
    parentAbs: toPosix(join(baseDir, ruleRelativeDir)),
    parentName: basenamePosix(ruleRelativeDir),
  };
}

export function buildMatchContext(filePath: string, baseDir: string): MatchContext {
  const parent = dirname(filePath);
  return {
    rel: toPosix(relative(baseDir, filePath)),
    abs: toPosix(filePath),
    name: basenamePosix(filePath),
    parentRel: toPosix(relative(baseDir, parent)),
    parentAbs: toPosix(parent),
    parentName: basenamePosix(parent),
  };
}

export function matchesAnyPattern(ctx: MatchContext, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const p = toPosix(pattern);
    return (
      globMatch(p, ctx.rel) ||
      globMatch(p, ctx.name) ||
      globMatch(p, ctx.abs) ||
      globMatch(p, ctx.parentRel) ||
      globMatch(p, ctx.parentName) ||
      globMatch(p, ctx.parentAbs)
    );
  });
}

export function matchesAnyExact(ctx: MatchContext, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const n = normalizeExactPattern(pattern);
    if (n === ctx.rel || n === ctx.abs) return true;
    return n === ctx.parentRel || n === ctx.parentAbs;
  });
}

export function overridesOf(skills: string[]): { excl: string[]; finc: string[]; fexc: string[] } {
  const excl: string[] = [];
  const finc: string[] = [];
  const fexc: string[] = [];
  for (const e of skills) {
    if (e.startsWith("!")) excl.push(e.slice(1));
    else if (e.startsWith("+")) finc.push(e.slice(1));
    else if (e.startsWith("-")) fexc.push(e.slice(1));
  }
  return { excl, finc, fexc };
}

function isEnabledByOverrides(
  ctx: MatchContext,
  skills: string[],
): { enabled: boolean; matched: string[] } {
  const { excl, finc, fexc } = overridesOf(skills);
  const matched: string[] = [];
  let enabled = true;
  if (excl.length > 0) {
    const hits = excl.filter((p) => matchesAnyPattern(ctx, [p]));
    if (hits.length > 0) {
      enabled = false;
      for (const h of hits) matched.push(`!${h}`);
    }
  }
  if (finc.length > 0) {
    const hits = finc.filter((p) => matchesAnyExact(ctx, [p]));
    if (hits.length > 0) {
      enabled = true;
      for (const h of hits) matched.push(`+${h}`);
    }
  }
  if (fexc.length > 0) {
    const hits = fexc.filter((p) => matchesAnyExact(ctx, [p]));
    if (hits.length > 0) {
      enabled = false;
      for (const h of hits) matched.push(`-${h}`);
    }
  }
  return { enabled, matched };
}

// ── Precedence (mirrors Pi resourcePrecedenceRank) ────────────────────

/**
 * Canonicalize an existing path for identity comparison. Uses realpath when
 * the path exists (resolving symlinks) and falls back to the lexical resolve
 * otherwise — matching `canonicalizeExistingPath` in the shared discovery
 * module. Two skills settings entries that alias the same directory via
 * different symlink spellings must be treated as the same root.
 */
function canonicalExistingPath(p: string): string {
  return canonicalizeExistingPath(resolve(p));
}

function precedenceRank(scope: "user" | "project", source: "auto" | "local"): number {
  const scopeBase = scope === "project" ? 0 : 2;
  return scopeBase + (source === "local" ? 0 : 1);
}

// ── Root construction ─────────────────────────────────────────────────

function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectAncestorAgentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const gitRoot = findGitRoot(cwd);
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(join(dir, ".agents", "skills"));
    if (gitRoot && dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function globalRoots(opts: BuildSkillInventoryOptions, settingsSkills: string[]): DiscoveredRoot[] {
  const home = opts.homeDir ?? homedir();
  const roots: DiscoveredRoot[] = [
    {
      dir: join(opts.agentDir, "skills"),
      mode: "pi",
      baseDir: opts.agentDir,
      scope: "user",
      source: "auto",
    },
    {
      dir: join(home, ".agents", "skills"),
      mode: "agents",
      baseDir: join(home, ".agents"),
      scope: "user",
      source: "auto",
    },
    {
      dir: join(home, ".claude", "skills"),
      mode: "agents",
      baseDir: opts.agentDir,
      scope: "user",
      source: "auto",
    },
  ];
  for (const entry of settingsSkills) {
    if (isOverride(entry) || isPlainGlob(entry)) continue;
    roots.push({
      dir: resolveLocal(entry, opts.agentDir),
      mode: "pi",
      baseDir: opts.agentDir,
      scope: "user",
      source: "local",
    });
  }
  return roots;
}

function projectRoots(
  opts: BuildSkillInventoryOptions,
  settingsSkills: string[],
): DiscoveredRoot[] {
  const home = opts.homeDir ?? homedir();
  const projectBase = join(opts.cwd, CONFIG_DIR_NAME);
  const roots: DiscoveredRoot[] = [
    {
      dir: join(projectBase, "skills"),
      mode: "pi",
      baseDir: projectBase,
      scope: "project",
      source: "auto",
    },
  ];
  for (const agentsDir of collectAncestorAgentsSkillDirs(opts.cwd)) {
    if (resolve(agentsDir) === resolve(join(home, ".agents", "skills"))) continue;
    roots.push({
      dir: agentsDir,
      mode: "agents",
      baseDir: dirname(agentsDir),
      scope: "project",
      source: "auto",
    });
  }
  roots.push({
    dir: join(opts.cwd, ".claude", "skills"),
    mode: "agents",
    baseDir: projectBase,
    scope: "project",
    source: "auto",
  });
  for (const entry of settingsSkills) {
    if (isOverride(entry) || isPlainGlob(entry)) continue;
    roots.push({
      dir: resolveLocal(entry, projectBase),
      mode: "pi",
      baseDir: projectBase,
      scope: "project",
      source: "local",
    });
  }
  return roots;
}

/** Theoretical project roots to display even when the project is untrusted. */
function projectRootPaths(opts: BuildSkillInventoryOptions): string[] {
  const home = opts.homeDir ?? homedir();
  const paths = [join(opts.cwd, CONFIG_DIR_NAME, "skills")];
  for (const agentsDir of collectAncestorAgentsSkillDirs(opts.cwd)) {
    if (resolve(agentsDir) === resolve(join(home, ".agents", "skills"))) continue;
    paths.push(agentsDir);
  }
  return paths;
}

/**
 * Returns true if the directory is a Claude Code skills directory
 * (global: <homeDir>/.claude/skills, project: <cwd>/.claude/skills).
 */
function isClaudeRoot(dir: string, opts: BuildSkillInventoryOptions): boolean {
  const home = opts.homeDir ?? homedir();
  return dir === join(home, ".claude", "skills") || dir === join(opts.cwd, ".claude", "skills");
}

/**
 * Classify a discovered root into a SkillRootKind for display. Claude
 * roots are distinguished from generic agents roots so the UI can render
 * an explicit enablement action.
 */
function detectRootKind(dir: string, opts: BuildSkillInventoryOptions): SkillRootKind {
  const home = opts.homeDir ?? homedir();
  if (dir === join(home, ".claude", "skills")) return "claude-global";
  if (dir === join(opts.cwd, ".claude", "skills")) return "claude-project";
  if (dir === join(opts.agentDir, "skills")) return "pi";
  if (dir === join(opts.cwd, CONFIG_DIR_NAME, "skills")) return "pi";
  if (dir === join(home, ".agents", "skills")) return "agents";
  if (dir.startsWith(`${join(home, ".agents")}/skills/`)) return "agents";
  // Project local entry: depends on how it was registered.
  return "configured";
}

/**
 * The relative entry to recommend in settings.json when enabling Claude.
 * Returns undefined for non-Claude roots.
 */
function detectRecommendedEntry(
  dir: string,
  opts: BuildSkillInventoryOptions,
  claude: boolean,
): string | undefined {
  if (!claude) return undefined;
  const home = opts.homeDir ?? homedir();
  return dir === join(home, ".claude", "skills") ? "../../.claude/skills" : "../.claude/skills";
}

/**
 * Detect whether the user has already registered a settings.json entry that
 * resolves canonically to this Claude root. Override (`!`/`+`/`-`) and glob
 * entries never count as a root source — only plain paths that resolve to
 * the Claude root are treated as configured.
 */
function detectConfiguredForPi(
  dir: string,
  opts: BuildSkillInventoryOptions,
  claude: boolean,
): boolean {
  if (!claude) return false;
  // Not exposed in the inventory function scope; rebuild a minimal lookup.
  const home = opts.homeDir ?? homedir();
  const claudeBase = resolve(
    dir === join(home, ".claude", "skills")
      ? join(home, ".claude", "skills")
      : join(opts.cwd, ".claude", "skills"),
  );
  const settingsPath =
    dir === join(home, ".claude", "skills")
      ? join(opts.agentDir, "settings.json")
      : join(opts.cwd, CONFIG_DIR_NAME, "settings.json");
  const fileSettings = readSettingsSkills(settingsPath);
  const claudeRootCanonical = canonicalExistingPath(claudeBase);
  return fileSettings.skills.some((entry) => {
    if (isOverride(entry) || isPlainGlob(entry)) return false;
    const expanded =
      entry === "~" ? homedir() : entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
    const resolved = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(
          dir === join(home, ".claude", "skills") ? opts.agentDir : join(opts.cwd, CONFIG_DIR_NAME),
          expanded,
        );
    return canonicalExistingPath(resolved) === claudeRootCanonical;
  });
}

function settingsPathFor(scope: SkillScope, opts: BuildSkillInventoryOptions): string {
  return scope === "global"
    ? join(opts.agentDir, "settings.json")
    : join(opts.cwd, CONFIG_DIR_NAME, "settings.json");
}

// ── Skill tree helpers ────────────────────────────────────────────────

function insertSkillIntoTree(
  tree: SkillRoot,
  item: SkillInventoryItem,
  meta: DiscoveredRoot,
): void {
  const segs = item.treePath ? item.treePath.split("/").filter(Boolean) : [];
  let node: { children: SkillChild[] } = tree;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (i === segs.length - 1) {
      node.children.push(item);
    } else {
      const existing = node.children.find(
        (c): c is SkillGroupNode => c.kind === "group" && c.name === seg,
      );
      if (existing) {
        node = existing;
      } else {
        const groupTreePath = segs.slice(0, i + 1).join("/");
        const groupDir = join(meta.dir, groupTreePath);
        const group: SkillGroupNode = {
          kind: "group",
          id: `${meta.dir}::${groupTreePath}`,
          sourceRoot: meta.dir,
          ruleBaseDir: meta.baseDir,
          ruleBaseRelativePath: toPosix(relative(meta.baseDir, groupDir)),
          name: seg,
          scope: meta.scope,
          source: meta.source,
          state: "all-off",
          ambiguous: false,
          children: [],
        };
        node.children.push(group);
        node = group;
      }
    }
  }
  if (segs.length === 0) node.children.push(item);
}

function collectLeaves(node: { children: SkillChild[] }): SkillInventoryItem[] {
  const out: SkillInventoryItem[] = [];
  for (const c of node.children) {
    if (c.kind === "skill") out.push(c);
    else out.push(...collectLeaves(c));
  }
  return out;
}

function annotateTree(
  node: { children: SkillChild[] } & Partial<SkillGroupNode>,
  groupPathRoots: Map<string, Set<string>>,
): void {
  for (const c of node.children) {
    if (c.kind === "group") {
      annotateTree(c, groupPathRoots);
      const key = `${c.scope}::${c.ruleBaseRelativePath}`;
      const set = groupPathRoots.get(key) ?? new Set<string>();
      set.add(c.sourceRoot);
      groupPathRoots.set(key, set);
    }
  }
  if (node.kind === "group") {
    const leaves = collectLeaves(node);
    const enabled = leaves.filter((l) => l.status === "enabled").length;
    node.state =
      leaves.length === 0
        ? "all-off"
        : enabled === leaves.length
          ? "all-on"
          : enabled === 0
            ? "all-off"
            : "mixed";
  }
}

function markGroupAmbiguity(
  node: { children: SkillChild[] },
  groupPathRoots: Map<string, Set<string>>,
): void {
  for (const c of node.children) {
    if (c.kind === "group") {
      c.ambiguous =
        (groupPathRoots.get(`${c.scope}::${c.ruleBaseRelativePath}`)?.size ?? 0) > 1 ||
        collectLeaves(c).some((l) => l.ambiguous);
      markGroupAmbiguity(c, groupPathRoots);
    }
  }
}

function sortTree(node: { children: SkillChild[] }): void {
  node.children.sort((a, b) => {
    const aSkill = a.kind === "skill";
    const bSkill = b.kind === "skill";
    if (aSkill !== bSkill) return aSkill ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) if (c.kind === "group") sortTree(c);
}

export function findSkillInRoots(roots: SkillRoot[], id: string): SkillInventoryItem | undefined {
  for (const root of roots) {
    const found = findSkillInNode(root, id);
    if (found) return found;
  }
  return undefined;
}

function findSkillInNode(
  node: { children: SkillChild[] },
  id: string,
): SkillInventoryItem | undefined {
  for (const c of node.children) {
    if (c.kind === "skill") {
      if (c.id === id) return c;
    } else {
      const found = findSkillInNode(c, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function findGroupInRoots(roots: SkillRoot[], id: string): SkillGroupNode | undefined {
  for (const root of roots) {
    const found = findGroupInNode(root, id);
    if (found) return found;
  }
  return undefined;
}

function findGroupInNode(node: { children: SkillChild[] }, id: string): SkillGroupNode | undefined {
  for (const c of node.children) {
    if (c.kind === "group") {
      if (c.id === id) return c;
      const found = findGroupInNode(c, id);
      if (found) return found;
    }
  }
  return undefined;
}

// ── Inventory assembly ────────────────────────────────────────────────

export function buildSkillInventory(opts: BuildSkillInventoryOptions): SkillInventory {
  const globalSettingsPath = join(opts.agentDir, "settings.json");
  const projectSettingsPath = join(opts.cwd, CONFIG_DIR_NAME, "settings.json");
  const settingsPath = settingsPathFor(opts.scope, opts);
  const diagnostics: SkillDiagnostic[] = [];

  // The inventory always reflects the full Pi discovery (global + project roots)
  // so that name collisions resolve in Pi's real precedence order. Each root is
  // resolved against its own scope's settings, exactly as Pi does. The `scope`
  // option selects which settings file mutations target and which custom rules
  // are surfaced; it never filters the displayed skills.
  const globalSettings = readSettingsSkills(globalSettingsPath);
  if (globalSettings.parseError)
    diagnostics.push({ path: globalSettingsPath, message: globalSettings.parseError });
  const trusted = Boolean(opts.projectTrusted);
  const projectSettingsRaw = trusted
    ? readSettingsSkills(projectSettingsPath)
    : { skills: [] as string[] };
  if (trusted && projectSettingsRaw.parseError) {
    diagnostics.push({
      path: projectSettingsPath,
      message: projectSettingsRaw.parseError as string,
    });
  }
  const scopeSettings = opts.scope === "global" ? globalSettings : projectSettingsRaw;
  const customRules = scopeSettings.skills.filter((s) => isPlainGlob(s)).map((s) => toPosix(s));

  const roots: DiscoveredRoot[] = [...globalRoots(opts, globalSettings.skills)];
  if (trusted) roots.push(...projectRoots(opts, projectSettingsRaw.skills));

  const discoveredRoots = roots.map((r) => r.dir).filter((d) => existsSync(d));
  if (opts.scope === "project" && !trusted) {
    // Still surface where project skills would be discovered so the UI can
    // show the trust warning next to the resource roots.
    for (const p of projectRootPaths(opts)) discoveredRoots.push(p);
  }

  const settingsForRoot = (root: DiscoveredRoot): string[] =>
    root.scope === "user" ? globalSettings.skills : projectSettingsRaw.skills;

  const rawSkills: RawSkill[] = [];
  for (const root of roots) {
    for (const s of discoverSkillsFromRoot(root, diagnostics)) rawSkills.push(s);
  }

  type Resolved = { raw: RawSkill; enabled: boolean; matching: string[] };
  const resolved: Resolved[] = rawSkills.map((raw) => {
    const ctx = buildMatchContext(raw.filePath, raw.root.baseDir);
    const { enabled, matched } = isEnabledByOverrides(ctx, settingsForRoot(raw.root));
    return { raw, enabled, matching: matched };
  });

  // Precedence order: sort by Pi's resourcePrecedenceRank. Array.sort is
  // stable, so equal-rank records keep discovery order (first-wins), matching
  // Pi's accumulator insertion order before loadSkills de-duplicates names.
  resolved.sort((a, b) => {
    const ra = precedenceRank(a.raw.root.scope, a.raw.root.source);
    const rb = precedenceRank(b.raw.root.scope, b.raw.root.source);
    return ra - rb;
  });

  const seenPath = new Set<string>();
  const items: SkillInventoryItem[] = [];
  const nameWinner = new Map<string, SkillInventoryItem>();
  for (const r of resolved) {
    if (seenPath.has(r.raw.canonicalPath)) continue;
    seenPath.add(r.raw.canonicalPath);
    const skillDir = dirname(r.raw.filePath);
    const ruleRelativeDir = toPosix(
      relative(r.raw.root.baseDir, r.raw.isConfiguredFile ? r.raw.filePath : skillDir),
    );
    const treePath = r.raw.isConfiguredFile ? "" : toPosix(relative(r.raw.root.dir, skillDir));
    const item: SkillInventoryItem = {
      kind: "skill",
      id: r.raw.canonicalPath,
      canonicalPath: r.raw.canonicalPath,
      name: r.raw.name,
      description: r.raw.description,
      enabled: r.enabled,
      status: r.enabled ? "enabled" : "disabled",
      ruleBaseDir: r.raw.root.baseDir,
      ruleRelativeDir,
      treePath,
      sourceRoot: r.raw.root.dir,
      scope: r.raw.root.scope,
      source: r.raw.root.source,
      matchingRules: r.matching,
      ambiguous: false,
    };
    items.push(item);
    if (r.enabled) {
      if (!nameWinner.has(r.raw.name)) nameWinner.set(r.raw.name, item);
    }
  }
  // Mark enabled losers as shadowed by their higher-precedence winner.
  for (const item of items) {
    if (!item.enabled) continue;
    const winner = nameWinner.get(item.name);
    if (winner && winner.id !== item.id) {
      item.status = "shadowed";
      item.shadowedBy = { id: winner.id, canonicalPath: winner.canonicalPath, name: winner.name };
    }
  }

  // Cross-root ambiguity for skill targets: a generated exact `+`/`-` rule is
  // relative to each root's Pi base; if the same relative dir resolves under
  // more than one sourceRoot in a scope, one portable rule would mutate
  // multiple roots, so such skills are read-only.
  const dirToRoots = new Map<string, Set<string>>();
  for (const it of items) {
    const dirKey = `${it.scope}::${it.ruleRelativeDir}`;
    const dirSet = dirToRoots.get(dirKey) ?? new Set<string>();
    dirSet.add(it.sourceRoot);
    dirToRoots.set(dirKey, dirSet);
  }
  for (const it of items) {
    if ((dirToRoots.get(`${it.scope}::${it.ruleRelativeDir}`)?.size ?? 0) > 1) it.ambiguous = true;
  }

  // Build one tree per sourceRoot. A skill's treePath (relative to its root
  // dir) decides its place: the final segment is the skill leaf, intermediate
  // segments become group containers. A single-skill dir like Humanizer-zh
  // (treePath "Humanizer-zh") is therefore a top-level skill row, not a group.
  const itemsByRoot = new Map<string, SkillInventoryItem[]>();
  for (const it of items) {
    const arr = itemsByRoot.get(it.sourceRoot) ?? [];
    arr.push(it);
    itemsByRoot.set(it.sourceRoot, arr);
  }
  const rootMeta = new Map(roots.map((r) => [r.dir, r]));
  const builtRoots: SkillRoot[] = [];
  const groupPathRoots = new Map<string, Set<string>>();
  for (const [sourceRoot, rootItems] of itemsByRoot) {
    const meta = rootMeta.get(sourceRoot);
    if (!meta) continue;
    const tree: SkillRoot = {
      sourceRoot: meta.dir,
      ruleBaseDir: meta.baseDir,
      scope: meta.scope,
      source: meta.source,
      rootKind: detectRootKind(meta.dir, opts),
      configuredForPi: detectConfiguredForPi(meta.dir, opts, isClaudeRoot(meta.dir, opts)),
      recommendedEntry: detectRecommendedEntry(meta.dir, opts, isClaudeRoot(meta.dir, opts)),
      settingsPath: isClaudeRoot(meta.dir, opts)
        ? settingsPathFor(meta.scope === "user" ? "global" : "project", opts)
        : undefined,
      children: [],
    };
    for (const it of rootItems) insertSkillIntoTree(tree, it, meta);
    annotateTree(tree, groupPathRoots);
    builtRoots.push(tree);
  }
  for (const tree of builtRoots) markGroupAmbiguity(tree, groupPathRoots);
  for (const tree of builtRoots) sortTree(tree);

  return {
    scope: opts.scope,
    settingsPath,
    trusted,
    roots: builtRoots,
    customRules,
    discoveredRoots,
    diagnostics,
  };
}

// ── Mutation ──────────────────────────────────────────────────────────

const mutationQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = mutationQueues.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  mutationQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Mirror Pi's settings migration (pi settings-manager.ts): older Pi releases
 * stored `skills` as an object `{ enableSkillCommands?, customDirectories? }`.
 * If we read that shape, promote `enableSkillCommands` to the top level (when
 * not already set) and turn `customDirectories` into the `skills` array. This
 * keeps Picot from silently dropping `enableSkillCommands` when it rewrites
 * settings.json. The rest of this module assumes `skills` is a string[].
 */
export function migrateLegacySkills(settings: Record<string, unknown>): Record<string, unknown> {
  const skills = settings.skills;
  if (!isPlainObject(skills)) return settings;
  const legacy = skills as { enableSkillCommands?: unknown; customDirectories?: unknown };
  if (legacy.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
    settings.enableSkillCommands = legacy.enableSkillCommands;
  }
  if (Array.isArray(legacy.customDirectories) && legacy.customDirectories.length > 0) {
    settings.skills = legacy.customDirectories.filter((v): v is string => typeof v === "string");
  } else {
    delete settings.skills;
  }
  return settings;
}

export function readSettingsObject(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "parse error";
    throw new Error(`Pi settings at ${settingsPath} must be valid JSON: ${msg}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Pi settings must be a JSON object: ${settingsPath}`);
  }
  return migrateLegacySkills(parsed);
}

export function writeSettingsAtomically(settingsPath: string, next: Record<string, unknown>): void {
  const dir = dirname(settingsPath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.picot-skills-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, settingsPath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

/**
 * Cross-process settings lock that is MUTUALLY COMPATIBLE with Pi's own
 * SettingsManager lock. Each Picot workspace runs its own pi process and the
 * global settings file is shared, so a process-local queue is not enough —
 * we must also interlock with Pi itself.
 *
 * Pi's SettingsManager.withLock (pi packages/coding-agent/src/core/settings-
 * manager.ts) calls `proper-lockfile.lockSync(path, { realpath: false })`,
 * which uses the mkdir strategy: the lock is an EMPTY DIRECTORY at
 * `${settingsPath}.lock`, staleness is judged by the directory's mtime against
 * a 10000ms threshold, and the holder periodically utimes it to stay fresh.
 *
 * We cannot import proper-lockfile inside a pi extension: it pulls
 * graceful-fs, which (in the pi bun --compile runtime) either fails to
 * resolve or re-patches pi's fs and corrupts pi's own lockSync probe. So we
 * replicate proper-lockfile's protocol directly with node:fs/promises, which
 * pi's embedded runtime supports natively:
 *   - acquire: mkdir(`${path}.lock`) is atomic; EEXIST means held.
 *   - staleness: mtime < now - 10000 → treat as stale, clear, retry.
 *   - release: rmdir(`${path}.lock`) (the dir is always empty).
 * Unlike Pi we always acquire (Picot also creates settings.json for new
 * projects); we do not utimes to keep the lock fresh because a mutation is a
 * sub-second read→parse→mutate→write and never approaches the 10s threshold.
 */
const SETTINGS_LOCK_STALE_MS = 10000;
const SETTINGS_LOCK_RETRY_DELAY_MS = 20;
const SETTINGS_LOCK_MAX_ATTEMPTS = 750; // ~15s ceiling

function settingsLockDir(settingsPath: string): string {
  return `${settingsPath}.lock`;
}

export async function withSettingsLock<T>(settingsPath: string, critical: () => T): Promise<T> {
  const lockDir = settingsLockDir(settingsPath);
  // Pi only acquires when settings.json already exists; Picot also creates it,
  // so ensure the parent dir is present before the lock mkdir (a project may
  // not yet have a .pi/ directory).
  mkdirSync(dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < SETTINGS_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockDir);
      try {
        return critical();
      } finally {
        await rmdir(lockDir).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let st: Stats | undefined;
      try {
        st = await asyncStat(lockDir);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile
        throw statError;
      }
      if (st.mtimeMs < Date.now() - SETTINGS_LOCK_STALE_MS) {
        // Pi's lock (or a crashed prior Picot holder) is stale — clear & retry.
        await rmdir(lockDir).catch(() => undefined);
        continue;
      }
      await sleep(SETTINGS_LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error(`Timed out waiting for settings lock: ${lockDir}`);
}

function posixRuleForSkill(item: SkillInventoryItem): string {
  return toPosix(item.ruleRelativeDir);
}

function filterInPlace<T>(arr: T[], keep: (v: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) if (!keep(arr[i])) arr.splice(i, 1);
}

function removeExactPrefix(arr: string[], rule: string, prefixes: string[]): void {
  filterInPlace(arr, (e) => {
    for (const p of prefixes) {
      if (e.startsWith(p) && normalizeExactPattern(e.slice(1)) === rule) return false;
    }
    return true;
  });
}

function ensureOverridePresent(arr: string[], prefix: string, body: string): void {
  const entry = `${prefix}${body}`;
  if (!arr.includes(entry)) arr.push(entry);
}

/**
 * Compute the next `skills` array from the current one and the requested mutation.
 * Preserves unrelated entries; managed exact `+`/`-` and group `!` rules are
 * added/removed idempotently per the spec's minimal-mutation policy.
 */
function computeNextSkills(
  current: string[],
  inventory: SkillInventory,
  target: SkillTarget,
  enabled: boolean,
): string[] {
  const next = current.map((e) => toPosix(e));

  if (target.kind === "skill") {
    const item = findSkillInRoots(inventory.roots, target.id);
    if (!item) throw new Error("Unknown skill target");
    const rule = posixRuleForSkill(item);
    if (!enabled) {
      // Disable: exact `-` has final precedence (overrides any `+`).
      ensureOverridePresent(next, "-", rule);
    } else {
      // Enable: remove the managed exact `-`, then force-include only if a
      // broader `!` exclusion still matches.
      removeExactPrefix(next, rule, ["-"]);
      const ctx = buildMatchContextFromRule(item.ruleRelativeDir, item.ruleBaseDir);
      const { excl } = overridesOf(next);
      if (excl.some((p) => matchesAnyPattern(ctx, [p]))) ensureOverridePresent(next, "+", rule);
    }
    return next;
  }

  const group = findGroupInRoots(inventory.roots, target.id);
  if (!group) throw new Error("Unknown group target");
  const groupRule = toPosix(group.ruleBaseRelativePath);
  const members = collectLeaves(group);
  const memberRules = new Set(members.map((i) => posixRuleForSkill(i)));

  if (!enabled) {
    // Disable group: drop managed `+` for members, add group `!`.
    filterInPlace(
      next,
      (e) => !(e.startsWith("+") && memberRules.has(normalizeExactPattern(e.slice(1)))),
    );
    ensureOverridePresent(next, "!", `${groupRule}/**`);
  } else {
    // Enable group: remove the exact group `!`; keep child `-`; add `+` for
    // members still matched by a remaining broader `!` (skip those already
    // force-excluded, since `-` has final precedence and `+` would be inert).
    filterInPlace(
      next,
      (e) => !(e.startsWith("!") && normalizeExactPattern(e.slice(1)) === `${groupRule}/**`),
    );
    const { excl, fexc } = overridesOf(next);
    for (const member of members) {
      const ctx = buildMatchContextFromRule(member.ruleRelativeDir, member.ruleBaseDir);
      if (matchesAnyExact(ctx, fexc)) continue;
      if (excl.some((p) => matchesAnyPattern(ctx, [p]))) {
        ensureOverridePresent(next, "+", posixRuleForSkill(member));
      }
    }
  }
  return next;
}

export async function mutateSkillEnabled(
  opts: MutateSkillEnabledOptions,
): Promise<SkillMutationResult> {
  const settingsPath = settingsPathFor(opts.scope, {
    scope: opts.scope,
    cwd: opts.cwd,
    agentDir: opts.agentDir,
  });
  return serialized(settingsPath, async () => {
    if (opts.scope === "project" && !opts.projectTrusted) {
      throw new Error("Project is not trusted; cannot mutate project skills");
    }
    const pre = buildSkillInventory(opts);
    const expectedScope = opts.scope === "global" ? "user" : "project";
    if (opts.target.kind === "skill") {
      const item = findSkillInRoots(pre.roots, opts.target.id);
      if (!item) throw new Error("Unknown skill target");
      if (item.scope !== expectedScope) {
        throw new Error("Skill does not belong to the selected scope");
      }
      if (item.ambiguous) {
        throw new Error(
          "Skill target is ambiguous across discovery roots; edit settings.json manually",
        );
      }
    } else {
      const group = findGroupInRoots(pre.roots, opts.target.id);
      if (!group) throw new Error("Unknown group target");
      if (group.scope !== expectedScope) {
        throw new Error("Group does not belong to the selected scope");
      }
      if (group.ambiguous) {
        throw new Error(
          "Group target is ambiguous across discovery roots; edit settings.json manually",
        );
      }
    }

    await withSettingsLock(settingsPath, () => {
      const original = readSettingsObject(settingsPath);
      const currentSkills = Array.isArray(original.skills)
        ? (original.skills.filter((s) => typeof s === "string") as string[])
        : [];
      const nextSkills = computeNextSkills(currentSkills, pre, opts.target, opts.enabled);
      writeSettingsAtomically(settingsPath, { ...original, skills: nextSkills });
    });

    const inventory = buildSkillInventory(opts);
    return { inventory, runtimeRestartRequired: true };
  });
}

export type ClaudeRootKind = "claude-global" | "claude-project";

export type MutateClaudeSkillRootOptions = BuildSkillInventoryOptions & {
  kind: ClaudeRootKind;
};

/**
 * Atomically register a Claude Code skills root in the matching settings.json
 * with the recommended relative entry. The new entry resolves to the existing
 * `<homeDir>/.claude/skills` (global) or `<cwd>/.claude/skills` (project)
 * directory. The mutation is canonical-idempotent: any existing entry that
 * resolves to the same canonical path (relative, alternate relative, or
 * absolute) is left untouched and the recommended entry is not appended again.
 *
 * The function rejects unknown kind, untrusted project, missing Claude root,
 * and lock-timeout / atomic-write failures. It never rewrites unrelated keys,
 * ordinary entries, custom globs, or `!`/`+`/`-` rules.
 */
export async function mutateClaudeSkillRoot(
  opts: MutateClaudeSkillRootOptions,
): Promise<SkillMutationResult> {
  if (opts.kind !== "claude-global" && opts.kind !== "claude-project") {
    throw new Error(`Unknown Claude root kind: ${String(opts.kind)}`);
  }
  if (opts.kind === "claude-project" && !opts.projectTrusted) {
    throw new Error("Project is not trusted; cannot mutate project skills");
  }
  const scope: SkillScope = opts.kind === "claude-global" ? "global" : "project";
  const settingsPath = settingsPathFor(scope, opts);
  const home = opts.homeDir ?? homedir();
  const claudeRoot = join(opts.kind === "claude-global" ? home : opts.cwd, ".claude", "skills");
  if (!existsSync(claudeRoot)) {
    throw new Error(`Claude root not found: ${claudeRoot}`);
  }
  const recommendedEntry =
    opts.kind === "claude-global" ? "../../.claude/skills" : "../.claude/skills";
  return serialized(settingsPath, async () => {
    await withSettingsLock(settingsPath, () => {
      const original = readSettingsObject(settingsPath);
      const currentSkills = Array.isArray(original.skills)
        ? (original.skills.filter((s) => typeof s === "string") as string[])
        : [];
      const claudeRootCanonical = canonicalExistingPath(claudeRoot);
      // Skip override and glob entries; only plain paths can match the Claude root.
      const hasCanonical = currentSkills.some((entry) => {
        if (isOverride(entry) || isPlainGlob(entry)) return false;
        const expanded =
          entry === "~"
            ? homedir()
            : entry.startsWith("~/")
              ? join(homedir(), entry.slice(2))
              : entry;
        const baseDir = scope === "global" ? opts.agentDir : join(opts.cwd, CONFIG_DIR_NAME);
        const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
        return canonicalExistingPath(resolved) === claudeRootCanonical;
      });
      const nextSkills = hasCanonical ? currentSkills : [...currentSkills, recommendedEntry];
      writeSettingsAtomically(settingsPath, { ...original, skills: nextSkills });
    });
    const inventory = buildSkillInventory({ ...opts, scope });
    return { inventory, runtimeRestartRequired: true };
  });
}
