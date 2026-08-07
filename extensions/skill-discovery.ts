// ABOUTME: Shared Pi-compatible skill collector for discovery, package, and install sources.
// ABOUTME: Recursively resolves SKILL.md files with frontmatter validation, ignore-file honor, and symlink dedupe.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { parse as parseYaml } from "yaml";

// ── Public types ──────────────────────────────────────────────────────

/**
 * Scope of a discovery root. `"global"` is the user-level agent/home scope;
 * `"project"` is the per-workspace scope. This matches `SkillScope` in
 * skill-inventory.ts and all three Skills specs. The legacy inventory item
 * `scope` field still uses the historical `"user" | "project"` spelling; the
 * adapter in skill-inventory.ts maps `"global"` back to `"user"`.
 */
export type SkillDiscoveryScope = "global" | "project";

export type SkillDiscoveryMode = "pi" | "agents";

export type SkillDiscoveryRoot = {
  /** Absolute directory or explicit Markdown file to discover from. */
  dir: string;
  /**
   * `"pi"` roots honor loose Markdown files at the root and use the
   * `.pi`/agent discovery rules; `"agents"` roots only honor nested
   * `<dir>/SKILL.md` skill directories.
   */
  mode: SkillDiscoveryMode;
  /**
   * Base directory used to compute relative paths (rule base). Usually the
   * parent of `dir`, matching Pi's resource base for that scope.
   */
  baseDir: string;
  scope: SkillDiscoveryScope;
  source: "auto" | "local" | "package" | "install";
};

export type SkillDiagnostic = { path?: string; message: string };

export type DiscoveredSkill = {
  /** Realpath-canonical skill file path; the stable identity of the skill. */
  canonicalPath: string;
  /** The on-disk file path that was read (may differ from canonical on macOS). */
  filePath: string;
  /** Directory containing the SKILL.md file. */
  skillDir: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
  /**
   * `true` when the root itself was an explicit Markdown file rather than a
   * directory. Such skills use their file path (not its directory) for exact
   * override matching, mirroring Pi's collectFilesFromPaths.
   */
  isConfiguredFile: boolean;
  root: SkillDiscoveryRoot;
};

// ── Constants mirroring Pi ────────────────────────────────────────────

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

// ── Path helpers (shared) ─────────────────────────────────────────────

/**
 * Convert a platform path to POSIX forward-slash form. All internal relative
 * paths and glob matching operate on POSIX paths regardless of OS.
 */
export function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Resolve an existing path to its realpath canonical form. Returns the input
 * unchanged if realpath fails (missing file, permission error) so callers can
 * treat the result as a best-effort identity without try/catch.
 */
export function canonicalizeExistingPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ── Simple .gitignore-style ignore matcher ────────────────────────────

type IgnoreMatcher = { ignores(relPosix: string, isDir: boolean): boolean };

function prefixIgnoreLine(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const rel = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${rel}` : rel;
}

function buildIgnoreMatcher(rootDir: string): IgnoreMatcher {
  // `ignore` implements .gitignore semantics (including trailing-slash
  // directory rules and negation) the same way Pi's resource loader does.
  const ig = ignore();
  const walk = (dir: string) => {
    const relDir = toPosixPath(relative(rootDir, dir));
    const prefix = relDir ? `${relDir}/` : "";
    for (const name of IGNORE_FILE_NAMES) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      try {
        const patterns = readFileSync(p, "utf-8")
          .split(/\r?\n/)
          .map((line) => prefixIgnoreLine(line, prefix))
          .filter((line): line is string => Boolean(line));
        if (patterns.length > 0) ig.add(patterns);
      } catch {
        // ignore unreadable ignore files
      }
    }
    for (const name of safeReaddir(dir)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      if (safeIsDir(full)) walk(full);
    }
  };
  walk(rootDir);
  return {
    ignores(relPosix, isDir) {
      return ig.ignores(isDir ? `${relPosix}/` : relPosix);
    },
  };
}

// ── Small fs helpers (silent on failure, like Pi) ─────────────────────

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeStat(p: string): { isFile: boolean; isDir: boolean } | null {
  try {
    const s = statSync(p);
    return { isFile: s.isFile(), isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

// ── Frontmatter parsing (minimal YAML subset for SKILL.md) ────────────

type ParsedFrontmatter = {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
};

function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return {};
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return {};
  const yamlText = normalized.slice(4, endIndex);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const fm = parsed as Record<string, unknown>;
  const result: ParsedFrontmatter = {};
  if (typeof fm.name === "string") result.name = fm.name;
  if (typeof fm.description === "string") result.description = fm.description;
  if (fm["disable-model-invocation"] === true) result.disableModelInvocation = true;
  return result;
}

// ── Name validation ───────────────────────────────────────────────────

/**
 * Validate a skill name against Pi's rules. Returns a list of human-readable
 * error messages; an empty list means the name is valid.
 */
export function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME_LENGTH)
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name))
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens)");
  if (name.startsWith("-") || name.endsWith("-"))
    errors.push("name must not start or end with a hyphen");
  if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
  return errors;
}

// ── Skill discovery (mirrors Pi collectSkillEntries / loadSkillFromFile) ─

function pushSkill(
  filePath: string,
  root: SkillDiscoveryRoot,
  diagnostics: SkillDiagnostic[],
  out: DiscoveredSkill[],
  isConfiguredFile = false,
): void {
  const canonical = canonicalizeExistingPath(filePath);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "failed to read skill file";
    diagnostics.push({ path: filePath, message: msg });
    return;
  }
  const frontmatter = parseFrontmatter(raw);
  const skillDir = dirname(filePath);
  const parentName = toPosixPath(skillDir).split("/").pop() || "";
  const description = frontmatter.description?.trim() ?? "";
  const name = frontmatter.name || parentName;
  if (!description) {
    diagnostics.push({ path: filePath, message: "description is required" });
    return;
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    diagnostics.push({
      path: filePath,
      message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
    });
  }
  for (const err of validateSkillName(name)) diagnostics.push({ path: filePath, message: err });
  out.push({
    canonicalPath: canonical,
    filePath,
    skillDir,
    name,
    description,
    disableModelInvocation: frontmatter.disableModelInvocation === true,
    isConfiguredFile,
    root,
  });
}

/**
 * Discover all skills under a single root. A root may be:
 *  - a directory: recursively walk, stopping under any directory that contains
 *    a SKILL.md, honoring .gitignore/.ignore/.fdignore and skipping hidden /
 *    node_modules directories. In `pi` mode, loose Markdown files at the root
 *    level are also discovered.
 *  - an explicit Markdown file: treat it as one configured skill.
 *
 * Returns deduplicated-by-canonical-path skills. Missing roots return `[]`
 * without diagnostics; explicit non-Markdown roots produce a diagnostic.
 */
export function discoverSkillsFromRoot(
  root: SkillDiscoveryRoot,
  diagnostics: SkillDiagnostic[],
): DiscoveredSkill[] {
  if (!existsSync(root.dir)) return [];
  const out: DiscoveredSkill[] = [];
  // A configured plain entry may point at a single skill file (Pi supports
  // this via collectFilesFromPaths); treat it as one skill and stop.
  const rootStat = safeStat(root.dir);
  if (rootStat?.isFile) {
    if (!root.dir.endsWith(".md")) {
      diagnostics.push({ path: root.dir, message: "configured skill file must be Markdown" });
      return out;
    }
    pushSkill(root.dir, root, diagnostics, out, true);
    return out;
  }
  const ig = buildIgnoreMatcher(root.dir);
  const collect = (dir: string) => {
    const entries = safeReaddir(dir);
    // SKILL.md in this dir → one skill, stop recursion under it.
    for (const name of entries) {
      if (name !== "SKILL.md") continue;
      const full = join(dir, name);
      const st = safeStat(full);
      if (!st?.isFile) continue;
      if (ig.ignores(toPosixPath(relative(root.dir, full)), false)) continue;
      pushSkill(full, root, diagnostics, out);
      return;
    }
    for (const name of entries) {
      if (name === "SKILL.md") continue;
      if (name.startsWith(".")) continue;
      if (name === "node_modules") continue;
      const full = join(dir, name);
      const st = safeStat(full);
      if (!st) continue;
      const rel = toPosixPath(relative(root.dir, full));
      if (st.isDir) {
        if (ig.ignores(`${rel}/`, true)) continue;
        collect(full);
        continue;
      }
      // Direct Markdown files are valid only at a `.pi`-style root in Pi mode.
      if (root.mode === "pi" && dir === root.dir && st.isFile && name.endsWith(".md")) {
        if (!ig.ignores(rel, false)) pushSkill(full, root, diagnostics, out);
      }
    }
  };
  collect(root.dir);
  return dedupeByCanonical(out);
}

/**
 * Discover skills from a mixed list of directory and explicit Markdown paths,
 * all sharing the same root metadata. Each directory delegates to recursive
 * discovery; each `.md` file delegates to explicit parsing; canonical
 * duplicates collapse; missing/non-Markdown paths become diagnostics.
 */
export function discoverSkillsFromPaths(
  paths: string[],
  root: SkillDiscoveryRoot,
  diagnostics: SkillDiagnostic[],
): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(root.baseDir, p);
    if (!existsSync(abs)) {
      diagnostics.push({ path: abs, message: "path does not exist" });
      continue;
    }
    const st = safeStat(abs);
    if (!st) {
      diagnostics.push({ path: abs, message: "path is not accessible" });
      continue;
    }
    if (st.isFile) {
      if (!abs.endsWith(".md")) {
        diagnostics.push({ path: abs, message: "configured skill file must be Markdown" });
        continue;
      }
      pushSkill(abs, root, diagnostics, out, true);
      continue;
    }
    // Directory: delegate to recursive discovery with the directory as the
    // effective root, preserving the caller's base/scope/source metadata.
    const subRoot: SkillDiscoveryRoot = { ...root, dir: abs };
    for (const s of discoverSkillsFromRoot(subRoot, diagnostics)) out.push(s);
  }
  return dedupeByCanonical(out);
}

/**
 * Deduplicate skills by canonical path, preserving first-seen order. This is
 * the same canonical-equivalence rule Pi uses to avoid double-loading a skill
 * reachable via both a real path and a symlink alias.
 */
export function dedupeByCanonical(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const seen = new Set<string>();
  const out: DiscoveredSkill[] = [];
  for (const s of skills) {
    if (seen.has(s.canonicalPath)) continue;
    seen.add(s.canonicalPath);
    out.push(s);
  }
  return out;
}
