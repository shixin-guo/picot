// ABOUTME: Resolves configured Pi package skill sources (npm/git/local) into installed roots and identity.
// ABOUTME: Read-only: parses settings.json packages[], dedupes by identity, and resolves install roots — never installs.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { globSync } from "glob";
import hostedGitInfo from "hosted-git-info";
import {
  type DiscoveredSkill,
  discoverSkillsFromPaths,
  type SkillDiscoveryRoot,
  toPosixPath,
} from "./skill-discovery.ts";
import {
  type BuildSkillInventoryOptions,
  buildMatchContext,
  matchesAnyExact,
  matchesAnyPattern,
  overridesOf,
  type SkillDiagnostic,
  type SkillScope,
} from "./skill-inventory.ts";

// ── Public types ──────────────────────────────────────────────────────

export type PackageSkillInventoryOptions = BuildSkillInventoryOptions;

export type PackageSkillCandidate = {
  id: string;
  canonicalPath: string;
  relativePath: string;
  name: string;
  description: string;
  diagnostics: SkillDiagnostic[];
};

export type PackageSkillCard = {
  id: string;
  source: string;
  identity: string;
  scope: SkillScope; // "global" | "project"
  effectivePackageRoot?: string;
  version?: string;
  candidates: PackageSkillCandidate[];
  diagnostics: SkillDiagnostic[];
};

export type PackageSkillInventory = {
  scope: SkillScope; // selected emphasis/count scope, not a resolution filter
  trusted: boolean;
  packages: PackageSkillCard[];
  diagnostics: SkillDiagnostic[];
};

// Internal resolution types (Task 2 produces source/identity/root only;
// Task 3 builds candidates on top of the effective package entries).

/**
 * A parsed package source. Mirrors Pi's ParsedSource union:
 * - npm: { type, spec, name, version?, range?, pinned }
 * - git: GitSource { type, repo, host, path, ref?, pinned }
 * - local: { type, path }
 */
export type ParsedPackageSource =
  | { type: "npm"; spec: string; name: string; version?: string; range?: string; pinned: boolean }
  | {
      type: "git";
      repo: string;
      host: string;
      path: string;
      ref?: string;
      pinned: boolean;
    }
  | { type: "local"; path: string };

/**
 * A raw configured package entry as read from settings.json `packages[]`.
 * May be a bare source string or an object `{ source, autoload? }`.
 */
export type ConfiguredPackageEntry = {
  source: string;
  /** True when the entry is an `autoload:false` delta; false otherwise. */
  autoload: boolean;
};

/**
 * A resolved package with its parsed source, scope, install root, and
 * provenance. The `sourceScope` is the scope of the settings entry that
 * contributed the effective source (used for autoload:false inheritance);
 * `scope` is the display/effective scope of this resolved entry.
 */
export type ResolvedPackage = {
  parsed: ParsedPackageSource;
  identity: string;
  /** Display/effective scope of this entry. */
  scope: SkillScope;
  /** Scope of the settings file that contributed the effective source. */
  sourceScope: SkillScope;
  /** The settings source string (for display). */
  source: string;
  /** True if this entry originated from an autoload:false delta. */
  autoload: boolean;
  /** Resolved install root, or undefined if not installed. */
  installedRoot?: string;
};

// ── Pi-compatible constants ───────────────────────────────────────────

const CONFIG_DIR_NAME = ".pi";

// ── Source parsing (mirrors Pi parseSource / isLocalPath / parseNpmSpec) ─

/**
 * Returns false (i.e. NOT local) for known non-local prefixes. Matches Pi's
 * `isLocalPath` exactly: npm:, git:, github:, http:, https:, ssh: are not
 * local; everything else (including git@host:path SSH shorthand) is local.
 */
function isLocalPath(source: string): boolean {
  const trimmed = source.trim();
  return !(
    trimmed.startsWith("npm:") ||
    trimmed.startsWith("git:") ||
    trimmed.startsWith("github:") ||
    trimmed.startsWith("http:") ||
    trimmed.startsWith("https:") ||
    trimmed.startsWith("ssh:")
  );
}

/**
 * Parse an npm spec into name and optional version. Mirrors Pi's regex
 * `/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/`.
 */
function parseNpmSpec(spec: string): { name: string; version?: string } {
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  if (!match) return { name: spec };
  const name = match[1] ?? spec;
  const version = match[2];
  return { name, version };
}

/**
 * Reimplementation of Pi's parseGitUrl. The package does not export it
 * (exports map only exposes `.` and `./rpc-entry`), and deep-path imports
 * fail under Pi's compiled runtime. A contract test cross-checks this
 * against the package's authoritative implementation loaded via createRequire
 * in the dev/test environment.
 *
 * Ported from Pi utils/git.ts: splitRef + buildGitSource + parseGenericGitUrl,
 * using the same `hosted-git-info` dependency Pi uses for host-specific
 * shorthand resolution.
 */
export function parseGitUrl(source: string): {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref?: string;
  pinned: boolean;
} | null {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

  // Without git: prefix, only accept explicit protocol URLs.
  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
    return null;
  }

  const split = splitRef(url);

  // Try hosted-git-info shorthand resolution first.
  const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of hostedCandidates) {
    const info = hostedGitInfo.fromUrl(candidate);
    if (info) {
      if (split.ref && info.project?.includes("@")) continue;
      const useHttpsPrefix =
        !split.repo.startsWith("http://") &&
        !split.repo.startsWith("https://") &&
        !split.repo.startsWith("ssh://") &&
        !split.repo.startsWith("git://") &&
        !split.repo.startsWith("git@");
      return buildGitSource({
        repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
        host: info.domain || "",
        path: `${info.user}/${info.project}`,
        ref: info.committish || split.ref || undefined,
      });
    }
  }

  // Fall back to generic https: prefix resolution.
  const httpsCandidates = [
    split.ref ? `https://${split.repo}#${split.ref}` : undefined,
    `https://${url}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of httpsCandidates) {
    const info = hostedGitInfo.fromUrl(candidate);
    if (info) {
      if (split.ref && info.project?.includes("@")) continue;
      return buildGitSource({
        repo: `https://${split.repo}`,
        host: info.domain || "",
        path: `${info.user}/${info.project}`,
        ref: info.committish || split.ref || undefined,
      });
    }
  }

  return parseGenericGitUrl(url);
}

/** Mirror Pi's splitRef: separate a trailing @ref or #ref from the repo. */
function splitRef(url: string): { repo: string; ref?: string } {
  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    const pathWithMaybeRef = scpLikeMatch[2] ?? "";
    const refSeparator = pathWithMaybeRef.indexOf("@");
    if (refSeparator < 0) return { repo: url };
    const repoPath = pathWithMaybeRef.slice(0, refSeparator);
    const ref = pathWithMaybeRef.slice(refSeparator + 1);
    if (!repoPath || !ref) return { repo: url };
    return { repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`, ref };
  }

  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
      const refSeparator = pathWithMaybeRef.indexOf("@");
      if (refSeparator < 0) return { repo: url };
      const repoPath = pathWithMaybeRef.slice(0, refSeparator);
      const ref = pathWithMaybeRef.slice(refSeparator + 1);
      if (!repoPath || !ref) return { repo: url };
      parsed.pathname = `/${repoPath}`;
      return { repo: parsed.toString().replace(/\/$/, ""), ref };
    } catch {
      return { repo: url };
    }
  }

  const slashIndex = url.indexOf("/");
  if (slashIndex < 0) return { repo: url };
  const host = url.slice(0, slashIndex);
  const pathWithMaybeRef = url.slice(slashIndex + 1);
  const refSeparator = pathWithMaybeRef.indexOf("@");
  if (refSeparator < 0) return { repo: url };
  const repoPath = pathWithMaybeRef.slice(0, refSeparator);
  const ref = pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) return { repo: url };
  return { repo: `${host}/${repoPath}`, ref };
}

function decodeForValidation(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function hasUnsafeGitInstallPart(value: string, allowSlash: boolean): boolean {
  const decoded = decodeForValidation(value);
  if (decoded === null) return true;
  const candidates = [value, decoded];
  for (const candidate of candidates) {
    if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/")) {
      return true;
    }
    if (!allowSlash && candidate.includes("/")) return true;
    if (candidate.split("/").includes("..")) return true;
  }
  return false;
}

function buildGitSource(args: { repo: string; host: string; path: string; ref?: string }): {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref?: string;
  pinned: boolean;
} | null {
  if (args.path.startsWith("/")) return null;
  const normalizedPath = args.path.replace(/\.git$/, "").replace(/^\/+/, "");
  if (!args.host || !normalizedPath || normalizedPath.split("/").length < 2) return null;
  if (hasUnsafeGitInstallPart(args.host, false) || hasUnsafeGitInstallPart(normalizedPath, true)) {
    return null;
  }
  return {
    type: "git",
    repo: args.repo,
    host: args.host,
    path: normalizedPath,
    ref: args.ref,
    pinned: args.ref !== undefined,
  };
}

function parseGenericGitUrl(url: string): {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref?: string;
  pinned: boolean;
} | null {
  const { repo: repoWithoutRef, ref } = splitRef(url);
  let repo = repoWithoutRef;
  let host = "";
  let path = "";

  const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    host = scpLikeMatch[1] ?? "";
    path = scpLikeMatch[2] ?? "";
  } else if (
    repoWithoutRef.startsWith("https://") ||
    repoWithoutRef.startsWith("http://") ||
    repoWithoutRef.startsWith("ssh://") ||
    repoWithoutRef.startsWith("git://")
  ) {
    try {
      const parsed = new URL(repoWithoutRef);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    const slashIndex = repoWithoutRef.indexOf("/");
    if (slashIndex < 0) return null;
    host = repoWithoutRef.slice(0, slashIndex);
    path = repoWithoutRef.slice(slashIndex + 1);
    if (!host.includes(".") && host !== "localhost") return null;
    repo = `https://${repoWithoutRef}`;
  }

  return buildGitSource({ repo, host, path, ref });
}

/**
 * Parse a package source string into a typed ParsedPackageSource. Mirrors
 * Pi's parseSource: npm: → npm, isLocalPath → local, else try parseGitUrl →
 * git, else fallback to local.
 */
export function parsePackageSource(source: string): ParsedPackageSource {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const { name, version } = parseNpmSpec(spec);
    return { type: "npm", spec, name, version, pinned: false };
  }
  if (isLocalPath(source)) {
    return { type: "local", path: source };
  }
  const git = parseGitUrl(source);
  if (git) return git;
  return { type: "local", path: source };
}

// ── Identity ──────────────────────────────────────────────────────────

/**
 * Compute a stable identity for a parsed source. Identity ignores version
 * (npm) and ref (git), so two entries with the same name/repo but different
 * versions/refs are the same package.
 */
export function packageIdentity(parsed: ParsedPackageSource): string {
  if (parsed.type === "npm") return `npm:${parsed.name}`;
  if (parsed.type === "git") return `git:${parsed.host}/${parsed.path}`;
  return `local:${parsed.path}`;
}

// ── Install root resolution ───────────────────────────────────────────

/**
 * Resolve the install root for a parsed source in a given scope. Mirrors
 * Pi's getNpmInstallPath / getGitInstallPath / local resolution, using only
 * the managed (non-legacy) paths. Throws if a normalized git path escapes the
 * install root (traversal protection, matching Pi's resolveManagedPath).
 *
 * `options` provides agentDir (global base) and cwd (project base).
 */
export function resolveInstalledPackageRoot(
  parsed: ParsedPackageSource,
  scope: SkillScope,
  options: { agentDir: string; cwd: string },
): string {
  if (parsed.type === "npm") {
    return scope === "global"
      ? join(options.agentDir, "npm", "node_modules", parsed.name)
      : join(options.cwd, CONFIG_DIR_NAME, "npm", "node_modules", parsed.name);
  }
  if (parsed.type === "git") {
    const installRoot =
      scope === "global"
        ? join(options.agentDir, "git")
        : join(options.cwd, CONFIG_DIR_NAME, "git");
    return resolveManagedPath(installRoot, parsed.host, parsed.path);
  }
  // local: relative global against agentDir, relative project against <cwd>/.pi,
  // absolute stays absolute.
  const p = expandLocalPath(parsed.path);
  if (isAbsolute(p)) return resolve(p);
  const base = scope === "global" ? options.agentDir : join(options.cwd, CONFIG_DIR_NAME);
  return resolve(base, p);
}

/** Expand ~ / ~/ to homedir, matching Pi's normalizePath. */
function expandLocalPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Resolve `parts` under `root`, refusing paths that escape root. Mirrors Pi's
 * resolveManagedPath (used by getGitInstallPath / getManagedNpmInstallPath).
 */
function resolveManagedPath(root: string, ...parts: string[]): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, ...parts);
  if (!isWithinPackage(resolvedPath, resolvedRoot)) {
    throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
  }
  return resolvedPath;
}

/**
 * Containment check shared by local-source resolution and manifest-entry
 * glob expansion. `path === root` is allowed (the package root itself may be
 * a valid entry); any path strictly beneath `<root>/` is allowed; anything
 * else (parent traversal, absolute path elsewhere, sibling directory) is not.
 */
function isWithinPackage(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

// ── Settings reading ──────────────────────────────────────────────────

type RawSettings = { packages?: unknown };

/**
 * Read packages[] and surface a per-entry diagnostic for malformed entries
 * (non-string, null, object without `source`). Returns the valid entries and
 * diagnostics for the malformed ones.
 */
function readSettingsPackagesWithDiags(
  settingsPath: string,
  diagnostics: SkillDiagnostic[],
): ConfiguredPackageEntry[] {
  if (!existsSync(settingsPath)) return [];
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "invalid JSON";
    diagnostics.push({ path: settingsPath, message: `Pi settings must be valid JSON: ${msg}` });
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diagnostics.push({ path: settingsPath, message: "Pi settings must be a JSON object" });
    return [];
  }
  const packages = (parsed as RawSettings).packages;
  if (!Array.isArray(packages)) return [];
  const entries: ConfiguredPackageEntry[] = [];
  let malformed = 0;
  for (const raw of packages) {
    if (typeof raw === "string") {
      entries.push({ source: raw, autoload: false });
      continue;
    }
    if (raw !== null && typeof raw === "object") {
      const obj = raw as { source?: unknown; autoload?: unknown };
      if (typeof obj.source === "string") {
        entries.push({ source: obj.source, autoload: obj.autoload === false });
        continue;
      }
    }
    malformed += 1;
  }
  if (malformed > 0) {
    diagnostics.push({
      path: settingsPath,
      message: `${malformed} malformed package entr${malformed === 1 ? "y" : "ies"} skipped`,
    });
  }
  return entries;
}

// ── Dedupe / precedence ───────────────────────────────────────────────

/**
 * Build one effective combined package list from project-first + global
 * settings entries, applying Pi-compatible precedence:
 *
 * - Project ordinary entries replace matching global entries (by identity).
 * - An `autoload:false` project delta that matches a global entry inherits
 *   that global entry's source/scope/base/installed-root, but retains project
 *   provenance for display (scope = "project", sourceScope = "global").
 * - An unmatched project `autoload:false` delta resolves against its own
 *   project source/root.
 * - Unrelated entries from both scopes remain.
 * - Duplicate same-scope identities keep the first (Pi first-wins).
 *
 * The response `scope` (passed in `options.scope`) controls emphasis/count,
 * NOT which effective packages are resolved.
 */
export function dedupeConfiguredPackages(
  globalEntries: ConfiguredPackageEntry[],
  projectEntries: ConfiguredPackageEntry[],
  options: { agentDir: string; cwd: string; projectTrusted: boolean },
): ResolvedPackage[] {
  /**
   * Deduplicate resolved packages within a single scope by identity, keeping
   * the first occurrence (Pi-compatible first-wins). This runs before
   * cross-scope precedence so duplicate same-scope entries collapse.
   */
  function dedupeSameScope(resolved: ResolvedPackage[]): ResolvedPackage[] {
    const seen = new Set<string>();
    const out: ResolvedPackage[] = [];
    for (const r of resolved) {
      if (seen.has(r.identity)) continue;
      seen.add(r.identity);
      out.push(r);
    }
    return out;
  }

  const resolveEntry = (entry: ConfiguredPackageEntry, scope: SkillScope): ResolvedPackage => {
    const parsed = parsePackageSource(entry.source);
    const identity = packageIdentity(parsed);
    let installedRoot: string | undefined;
    try {
      const root = resolveInstalledPackageRoot(parsed, scope, options);
      installedRoot = existsSync(root) && statSync(root).isDirectory() ? root : undefined;
    } catch {
      installedRoot = undefined;
    }
    return {
      parsed,
      identity,
      scope,
      sourceScope: scope,
      source: entry.source,
      autoload: entry.autoload,
      installedRoot,
    };
  };

  const resolvedGlobal = dedupeSameScope(globalEntries.map((e) => resolveEntry(e, "global")));
  if (!options.projectTrusted) return resolvedGlobal;

  const resolvedProject = dedupeSameScope(projectEntries.map((e) => resolveEntry(e, "project")));
  const globalByIdentity = new Map(resolvedGlobal.map((r) => [r.identity, r]));
  const result: ResolvedPackage[] = [];
  const seenIdentities = new Set<string>();

  for (const proj of resolvedProject) {
    if (seenIdentities.has(proj.identity)) continue;
    seenIdentities.add(proj.identity);
    const matchingGlobal = globalByIdentity.get(proj.identity);
    if (proj.autoload && matchingGlobal) {
      // autoload:false project delta: inherit the global source/root, keep
      // project provenance for display.
      result.push({
        ...matchingGlobal,
        scope: "project",
        sourceScope: "global",
        source: proj.source,
        autoload: true,
      });
    } else {
      result.push(proj);
    }
  }
  for (const glob of resolvedGlobal) {
    if (seenIdentities.has(glob.identity)) continue;
    seenIdentities.add(glob.identity);
    result.push(glob);
  }
  return result;
}

// ── Manifest candidate collection (Task 3) ────────────────────────────

/** Read package.json's `pi` manifest object, or null if absent/invalid. */
function readPiManifest(packageRoot: string): { skills?: unknown } | null {
  const pkgJsonPath = join(packageRoot, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const pkg = parsed as { pi?: unknown };
  if (typeof pkg.pi !== "object" || pkg.pi === null || Array.isArray(pkg.pi)) return null;
  return pkg.pi as { skills?: unknown };
}

/** True if a manifest entry is an override pattern (!, +, -). */
function isOverridePattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

/** True if a manifest entry contains a glob char. */
function hasGlobPattern(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

/**
 * Collect candidate skill files from a package root, mirroring Pi's
 * collectManifestFiles for the "skills" resource type:
 * - If package.json `pi.skills` is a non-empty array: collect files from its
 *   source entries (plain paths + globs) via the shared discovery collector,
 *   then apply manifest `!`/`+`/`-` override patterns with Pi precedence.
 * - If absent/empty: fall back to the conventional `<packageRoot>/skills/`
 *   directory.
 *
 * Only the package-manifest `pi.skills` override entries are evaluated against
 * the collected skill files. The separate user-owned `settings.json.packages[]
 * .skills` filter is intentionally NOT evaluated — bundled candidates are
 * read-only and never claim an effective enabled/disabled state.
 */
export function collectPackageSkillCandidates(
  pkg: ResolvedPackage,
  diagnostics: SkillDiagnostic[],
): PackageSkillCandidate[] {
  const packageRoot = pkg.installedRoot;
  if (!packageRoot) return [];
  const manifest = readPiManifest(packageRoot);
  // Distinguish three cases, matching Pi's collectDefaultResources:
  //   - pi.skills undefined → conventional <packageRoot>/skills/ fallback;
  //   - pi.skills is an array (including []) → strict manifest processing;
  //   - pi.skills is any other type → record a diagnostic and fall back to
  //     conventional, matching Pi's defensive behavior for malformed manifests.
  const manifestSkillsRaw = manifest?.skills;
  let manifestEntries: string[];
  let manifestDeclared = false;
  if (Array.isArray(manifestSkillsRaw)) {
    manifestDeclared = true;
    manifestEntries = manifestSkillsRaw.every((s) => typeof s === "string")
      ? (manifestSkillsRaw as string[])
      : [];
  } else {
    manifestEntries = [];
    if (manifestSkillsRaw !== undefined) {
      diagnostics.push({
        message: `pi.skills must be a string array; got ${typeof manifestSkillsRaw}, falling back to skills/`,
      });
    }
  }

  const discoveryRoot: SkillDiscoveryRoot = {
    dir: packageRoot,
    mode: "pi",
    baseDir: packageRoot,
    scope: pkg.scope,
    source: "package",
  };

  let collected: DiscoveredSkill[];
  if (manifestDeclared || manifestEntries.length > 0) {
    // Source entries (plain paths + globs) resolve to files/dirs under the
    // package root, then the shared collector walks them. A malicious or
    // compromised package manifest could declare a parent-directory glob or
    // an absolute path to disclose arbitrary host files; reject any resolved
    // path that escapes packageRoot and record a diagnostic instead.
    const sourceEntries = manifestEntries.filter((e) => !isOverridePattern(e));
    const resolvedPaths: string[] = [];
    const MAX_MANIFEST_MATCHES = 10_000;
    for (const entry of sourceEntries) {
      const matches = hasGlobPattern(entry)
        ? globSync(entry, { cwd: packageRoot, absolute: true, dot: false, nodir: false })
        : [resolve(packageRoot, entry)];
      if (matches.length > MAX_MANIFEST_MATCHES) {
        diagnostics.push({
          message: `Manifest entry matched ${matches.length} paths; truncated to ${MAX_MANIFEST_MATCHES}`,
        });
      }
      for (const m of matches.slice(0, MAX_MANIFEST_MATCHES)) {
        const resolved = resolve(m);
        if (isWithinPackage(resolved, packageRoot)) {
          resolvedPaths.push(resolved);
        } else {
          diagnostics.push({
            message: `Refused manifest entry outside package root: ${entry} -> ${resolved}`,
          });
        }
      }
    }
    collected = discoverSkillsFromPaths(resolvedPaths, discoveryRoot, diagnostics);
    // Apply manifest override patterns (!, +, -) against the collected files.
    const overrideEntries = manifestEntries.filter((e) => isOverridePattern(e));
    if (overrideEntries.length > 0) {
      collected = applyManifestOverrides(collected, overrideEntries, packageRoot);
    }
  } else {
    // Conventional fallback: <packageRoot>/skills/ directory.
    collected = discoverSkillsFromPaths([join(packageRoot, "skills")], discoveryRoot, diagnostics);
  }

  // Build candidate cards with stable IDs and POSIX package-root-relative paths.
  return collected.map((s) => {
    const candidateDiags: SkillDiagnostic[] = [];
    const relativePath = toPosixPath(relative(packageRoot, s.skillDir));
    return {
      id: `${pkg.identity}::${s.canonicalPath}`,
      canonicalPath: s.canonicalPath,
      relativePath: relativePath || ".",
      name: s.name,
      description: s.description,
      diagnostics: candidateDiags,
    };
  });
}

/**
 * Apply Pi-compatible `!`/`+`/`-` override patterns to the collected skill
 * files, using the same match context as the inventory matcher. Precedence:
 * `+` force-include adds back, `-` force-exclude removes (final precedence),
 * `!` excludes from the full set. Mirrors Pi's applyPatterns.
 */
function applyManifestOverrides(
  collected: DiscoveredSkill[],
  overrideEntries: string[],
  packageRoot: string,
): DiscoveredSkill[] {
  const { excl, finc, fexc } = overridesOf(overrideEntries);
  // Start from the full collected set.
  let result = collected;
  // Step 1: `!` excludes.
  if (excl.length > 0) {
    result = result.filter((s) => {
      const ctx = buildMatchContext(s.filePath, packageRoot);
      return !matchesAnyPattern(ctx, excl);
    });
  }
  // Step 2: `+` force-include (add back from the original full set).
  if (finc.length > 0) {
    for (const s of collected) {
      const ctx = buildMatchContext(s.filePath, packageRoot);
      if (!result.includes(s) && matchesAnyExact(ctx, finc)) result.push(s);
    }
  }
  // Step 3: `-` force-exclude (final precedence).
  if (fexc.length > 0) {
    result = result.filter((s) => {
      const ctx = buildMatchContext(s.filePath, packageRoot);
      return !matchesAnyExact(ctx, fexc);
    });
  }
  return result;
}

// ── Public inventory builder (Task 2: source/identity/root only) ──────

/**
 * Build a package skill inventory for the requested scope. Task 2 produces
 * source/identity/root cards only; Task 3 fills in candidates via the shared
 * discovery collector.
 *
 * For untrusted project scope, returns `{ trusted:false, packages:[] }`
 * without reading or disclosing project package paths/diagnostics.
 */
export function buildPackageSkillInventory(
  options: PackageSkillInventoryOptions,
): PackageSkillInventory {
  const globalSettingsPath = join(options.agentDir, "settings.json");
  const projectSettingsPath = join(options.cwd, CONFIG_DIR_NAME, "settings.json");
  const diagnostics: SkillDiagnostic[] = [];
  const trusted = Boolean(options.projectTrusted);

  // Untrusted project: do NOT read project settings; return global-only with
  // trusted:false when the requested scope is project.
  if (options.scope === "project" && !trusted) {
    return { scope: "project", trusted: false, packages: [], diagnostics };
  }

  const globalEntries = readSettingsPackagesWithDiags(globalSettingsPath, diagnostics);
  const projectEntries = trusted
    ? readSettingsPackagesWithDiags(projectSettingsPath, diagnostics)
    : [];

  const resolved = dedupeConfiguredPackages(globalEntries, projectEntries, {
    agentDir: options.agentDir,
    cwd: options.cwd,
    projectTrusted: trusted,
  });

  const packages: PackageSkillCard[] = resolved.map((r) => {
    const cardDiags: SkillDiagnostic[] = [];
    if (!r.installedRoot) {
      cardDiags.push({ message: "package is not installed" });
    }
    const version = readPackageVersion(r.installedRoot);
    const candidates = r.installedRoot ? collectPackageSkillCandidates(r, cardDiags) : [];
    return {
      id: r.identity,
      source: r.source,
      identity: r.identity,
      scope: r.scope,
      effectivePackageRoot: r.installedRoot,
      version,
      candidates,
      diagnostics: cardDiags,
    };
  });

  // Only packages that actually contribute skills are shown — a configured
  // but skill-less package (uninstalled, empty manifest, or no skills/ dir)
  // adds noise to the Skills page, so drop it here rather than in the UI.
  const packagesWithSkills = packages.filter((p) => p.candidates.length > 0);
  return { scope: options.scope, trusted, packages: packagesWithSkills, diagnostics };
}

/** Read the version from a package's package.json, if present. */
function readPackageVersion(installedRoot?: string): string | undefined {
  if (!installedRoot) return undefined;
  const pkgJson = join(installedRoot, "package.json");
  if (!existsSync(pkgJson)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
