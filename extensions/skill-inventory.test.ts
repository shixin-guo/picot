// @vitest-environment node

// ABOUTME: Exercises Pi-compatible skill discovery and rule resolution for the Skills Settings page.
// ABOUTME: Uses isolated temporary directories so tests never read a developer's real agent configuration.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir as mkdirAsync, rmdir as rmdirAsync, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuildSkillInventoryOptions,
  buildSkillInventory,
  type MutateSkillEnabledOptions,
  mutateClaudeSkillRoot,
  mutateSkillEnabled,
  type SkillChild,
  type SkillGroupNode,
  type SkillInventory,
  type SkillInventoryItem,
  type SkillMutationResult,
} from "./skill-inventory.ts";

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "skill-inv-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJson(p: string, obj: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function writeSkill(
  dir: string,
  fm: { name?: string; description?: string; extra?: string },
): string {
  mkdirSync(dir, { recursive: true });
  const lines = ["---"];
  if (fm.name !== undefined) lines.push(`name: ${fm.name}`);
  lines.push(`description: ${fm.description ?? "default skill description"}`);
  if (fm.extra) lines.push(fm.extra);
  lines.push("---", "");
  const file = join(dir, "SKILL.md");
  writeFileSync(file, lines.join("\n"));
  return file;
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8"));
}

type Overrides = Partial<BuildSkillInventoryOptions> & {
  globalSettings?: { skills?: string[]; [k: string]: unknown };
  projectSettings?: { skills?: string[]; [k: string]: unknown };
  duplicateSkillName?: string;
  globalConfiguredSkillName?: string;
  projectAutoSkillName?: string;
};

function makeOptions(overrides: Overrides = {}): BuildSkillInventoryOptions {
  const agentDir = join(tmpRoot, "agent");
  const homeDir = join(tmpRoot, "home");
  const cwd = join(tmpRoot, "workspace");

  writeSkill(join(agentDir, "skills", "baoyu-skills", "baoyu-diagram"), {
    name: "baoyu-diagram",
    description: "diagram skill",
  });
  writeSkill(join(agentDir, "skills", "baoyu-skills", "baoyu-article-illustrator"), {
    name: "baoyu-article-illustrator",
    description: "article skill",
  });
  writeSkill(join(agentDir, "skills", "baoyu-skills", "baoyu-infographic"), {
    name: "baoyu-infographic",
    description: "info skill",
  });
  writeSkill(join(homeDir, ".agents", "skills", "research", "deep-research"), {
    name: "deep-research",
    description: "research skill",
  });
  writeSkill(join(cwd, ".pi", "skills", "release", "release-notes"), {
    name: "release-notes",
    description: "release skill",
  });

  const opts: BuildSkillInventoryOptions = {
    scope: "global",
    cwd,
    agentDir,
    homeDir,
    projectTrusted: false,
    ...overrides,
  };

  if (overrides.globalSettings)
    writeJson(join(agentDir, "settings.json"), overrides.globalSettings);
  if (overrides.projectSettings)
    writeJson(join(cwd, ".pi", "settings.json"), overrides.projectSettings);

  if (overrides.duplicateSkillName) {
    const n = overrides.duplicateSkillName;
    writeSkill(join(cwd, ".pi", "skills", "dup", n), { name: n, description: "project dup" });
    writeSkill(join(agentDir, "skills", "dup", n), { name: n, description: "user dup" });
    opts.projectTrusted = true;
  }

  if (
    overrides.globalConfiguredSkillName &&
    overrides.projectAutoSkillName &&
    overrides.globalConfiguredSkillName === overrides.projectAutoSkillName
  ) {
    const n = overrides.globalConfiguredSkillName;
    writeSkill(join(agentDir, "external", n), { name: n, description: "global configured" });
    writeSkill(join(cwd, ".pi", "skills", "sharedgroup", n), {
      name: n,
      description: "project auto",
    });
    const existing = overrides.globalSettings ?? {};
    writeJson(join(agentDir, "settings.json"), {
      ...existing,
      skills: [...(existing.skills ?? []), `external/${n}`],
    });
    opts.projectTrusted = true;
  }

  return opts;
}

function flatItems(inv: SkillInventory) {
  const out: SkillInventoryItem[] = [];
  const walk = (children: SkillChild[]) => {
    for (const c of children) {
      if (c.kind === "skill") out.push(c);
      else walk(c.children);
    }
  };
  for (const root of inv.roots) walk(root.children);
  return out;
}

function findGroup(inv: SkillInventory, groupRel: string): SkillGroupNode | undefined {
  const walk = (children: SkillChild[]): SkillGroupNode | undefined => {
    for (const c of children) {
      if (c.kind === "group") {
        if (c.ruleBaseRelativePath === groupRel) return c;
        const found = walk(c.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const root of inv.roots) {
    const found = walk(root.children);
    if (found) return found;
  }
  return undefined;
}

function findSkill(inv: SkillInventory, name: string) {
  const matches = flatItems(inv).filter((i) => i.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one "${name}", got ${matches.length}: ${JSON.stringify(matches, null, 2)}`,
    );
  }
  return matches[0];
}

function findAllByName(inv: SkillInventory, name: string) {
  const matches = flatItems(inv).filter((i) => i.name === name);
  if (matches.length === 0) throw new Error(`no item named "${name}"`);
  return matches;
}

// ── Discovery ─────────────────────────────────────────────────────────

describe("skill discovery", () => {
  it("discovers nested skills under every global root and groups rules relative to each Pi base", () => {
    const inv = buildSkillInventory(
      makeOptions({
        globalSettings: {
          skills: ["!skills/baoyu-skills/**", "+skills/baoyu-skills/baoyu-diagram"],
        },
      }),
    );

    expect(findGroup(inv, "skills/baoyu-skills")).toBeDefined();
    expect(findSkill(inv, "baoyu-diagram").enabled).toBe(true);
    expect(findSkill(inv, "deep-research").enabled).toBe(true);
  });

  it("uses a configured non-SKILL Markdown file's file path for exact overrides", async () => {
    const opts = makeOptions({ globalSettings: { skills: ["external/release.md"] } });
    const file = join(opts.agentDir, "external", "release.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "---\nname: release-file\ndescription: configured file\n---\n");
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "release-file"),
      enabled: false,
    });
    expect(readJson(join(opts.agentDir, "settings.json")).skills).toEqual([
      "external/release.md",
      "-external/release.md",
    ]);
  });

  it("does not use bare discovery-relative directory names as Pi patterns", () => {
    const inv = buildSkillInventory(
      makeOptions({ globalSettings: { skills: ["!baoyu-skills/**"] } }),
    );
    expect(findSkill(inv, "baoyu-diagram").enabled).toBe(true);
  });

  it("accepts direct Markdown at a .pi-style root but not at an .agents root", () => {
    const opts = makeOptions();
    // A loose .md (not SKILL.md) directly at a `.pi`-style root is discovered.
    const piRootMd = join(opts.agentDir, "skills", "loose.md");
    mkdirSync(dirname(piRootMd), { recursive: true });
    writeFileSync(piRootMd, "---\nname: loose\ndescription: root level\n---\n");
    // The same shape at an `.agents` root is excluded by Pi's discovery rules.
    const home = (opts as { homeDir: string }).homeDir;
    const agentsRootMd = join(home, ".agents", "skills", "ignored.md");
    mkdirSync(dirname(agentsRootMd), { recursive: true });
    writeFileSync(agentsRootMd, "---\nname: agents-loose\ndescription: excluded\n---\n");
    const inv = buildSkillInventory(opts);
    expect(flatItems(inv).some((i) => i.name === "loose")).toBe(true);
    expect(flatItems(inv).some((i) => i.name === "agents-loose")).toBe(false);
  });

  it("stops recursion under a directory that contains SKILL.md", () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", "nested-stop"), {
      name: "nested-stop",
      description: "top skill",
    });
    writeSkill(join(opts.agentDir, "skills", "nested-stop", "inner", "hidden"), {
      name: "inner-hidden",
      description: "must not be discovered",
    });
    const inv = buildSkillInventory(opts);
    expect(flatItems(inv).some((i) => i.name === "nested-stop")).toBe(true);
    expect(flatItems(inv).some((i) => i.name === "inner-hidden")).toBe(false);
  });

  it("excludes hidden directories, node_modules, and ignore-file entries", () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", ".hidden", "skill"), {
      name: "hidden-skill",
      description: "h",
    });
    writeSkill(join(opts.agentDir, "skills", "node_modules", "pkg"), {
      name: "nm-skill",
      description: "n",
    });
    const ignoredDir = join(opts.agentDir, "skills", "ignored-group", "child");
    writeSkill(ignoredDir, { name: "ignored-child", description: "i" });
    writeFileSync(join(opts.agentDir, "skills", ".gitignore"), "ignored-group/\n");
    const inv = buildSkillInventory(opts);
    const names = flatItems(inv).map((i) => i.name);
    expect(names).not.toContain("hidden-skill");
    expect(names).not.toContain("nm-skill");
    expect(names).not.toContain("ignored-child");
  });

  it("deduplicates symlinked skills by canonical path", () => {
    const opts = makeOptions();
    const real = join(opts.agentDir, "skills", "baoyu-skills", "baoyu-diagram");
    const linkDir = join(opts.agentDir, "skills", "baoyu-skills", "baoyu-diagram-link");
    try {
      symlinkSync(real, linkDir);
    } catch {
      return; // symlink not supported on this platform / without privileges
    }
    const inv = buildSkillInventory(opts);
    const matches = flatItems(inv).filter((i) => i.name === "baoyu-diagram");
    expect(matches.length).toBe(1);
  });
});

// ── Rule resolution ───────────────────────────────────────────────────

describe("rule resolution", () => {
  it("applies ! then + then - precedence and reports matching rules", () => {
    const inv = buildSkillInventory(
      makeOptions({
        globalSettings: {
          skills: [
            "!skills/baoyu-skills/**",
            "+skills/baoyu-skills/baoyu-diagram",
            "-skills/baoyu-skills/baoyu-article-illustrator",
          ],
        },
      }),
    );
    expect(findSkill(inv, "baoyu-diagram").enabled).toBe(true); // + overrides !
    expect(findSkill(inv, "baoyu-article-illustrator").enabled).toBe(false); // - final
    expect(findSkill(inv, "baoyu-infographic").enabled).toBe(false); // ! excludes
  });

  it("derives group state as all-on / all-off / mixed", () => {
    const inv = buildSkillInventory(
      makeOptions({ globalSettings: { skills: ["!skills/baoyu-skills/**"] } }),
    );
    const group = findGroup(inv, "skills/baoyu-skills");
    expect(group?.state).toBe("all-off");
  });
});

// ── Collisions & custom rules ─────────────────────────────────────────

describe("collisions and custom rules", () => {
  it("ranks a project-auto skill above a global configured skill of the same name", () => {
    const inv = buildSkillInventory(
      makeOptions({ globalConfiguredSkillName: "shared", projectAutoSkillName: "shared" }),
    );
    const [winner, loser] = findAllByName(inv, "shared");
    expect(winner.sourceRoot).toContain("workspace/.pi/skills");
    expect(winner.status).toBe("enabled");
    expect(loser.status).toBe("shadowed");
    expect(loser.shadowedBy?.id).toBe(winner.id);
  });

  it("marks a same-scope duplicate shadowed by the higher-precedence winner", () => {
    const inv = buildSkillInventory(makeOptions({ duplicateSkillName: "review", scope: "global" }));
    const [winner, loser] = findAllByName(inv, "review");
    expect(winner.scope).toBe("project");
    expect(loser.scope).toBe("user");
    expect(loser.status).toBe("shadowed");
  });

  it("reports existing unprefixed glob entries as read-only custom rules", () => {
    const inv = buildSkillInventory(
      makeOptions({ globalSettings: { skills: ["skills/external/*"] } }),
    );
    expect(inv.customRules).toEqual(["skills/external/*"]);
  });

  it("does not mark equal rule paths in separate settings scopes ambiguous", () => {
    const opts = makeOptions({ scope: "global", projectTrusted: true });
    writeSkill(join(opts.cwd, ".pi", "skills", "baoyu-skills", "baoyu-diagram"), {
      name: "project-diagram",
      description: "project duplicate path",
    });
    const inv = buildSkillInventory(opts);
    expect(findSkill(inv, "baoyu-diagram").ambiguous).toBe(false);
    expect(findSkill(inv, "project-diagram").ambiguous).toBe(false);
  });

  it("flags a group ambiguous when two roots share its base-relative path", () => {
    const opts = makeOptions();
    const home = (opts as { homeDir: string }).homeDir;
    writeSkill(join(opts.agentDir, "skills", "suite", "a"), { name: "suite-a", description: "a" });
    writeSkill(join(home, ".agents", "skills", "suite", "b"), {
      name: "suite-b",
      description: "b",
    });
    const inv = buildSkillInventory(opts);
    const suiteGroup = findGroup(inv, "skills/suite");
    expect(suiteGroup).toBeDefined();
    expect(suiteGroup?.ambiguous).toBe(true);
  });
});

// ── Project scope & trust ─────────────────────────────────────────────

describe("project scope and trust", () => {
  it("returns no project groups and a trust diagnostic for an untrusted project", () => {
    const inv = buildSkillInventory(makeOptions({ scope: "project", projectTrusted: false }));
    expect(inv.trusted).toBe(false);
    expect(flatItems(inv).filter((i) => i.scope === "project")).toEqual([]);
    expect(inv.discoveredRoots.some((r) => r.includes(".pi"))).toBe(true);
  });

  it("discovers project skills when trusted", () => {
    const inv = buildSkillInventory(makeOptions({ scope: "project", projectTrusted: true }));
    expect(inv.trusted).toBe(true);
    expect(flatItems(inv).some((i) => i.name === "release-notes")).toBe(true);
  });
});

describe("tree grouping", () => {
  it("places a single-skill directory as a top-level skill row, not a group card", () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", "Humanizer-zh"), {
      name: "humanizer-zh",
      description: "hz",
    });
    const inv = buildSkillInventory(opts);
    const root = inv.roots.find((r) => r.sourceRoot === join(opts.agentDir, "skills"));
    expect(root).toBeDefined();
    expect(root?.children.some((c) => c.kind === "skill" && c.name === "humanizer-zh")).toBe(true);
    expect(root?.children.some((c) => c.kind === "group" && c.name === "Humanizer-zh")).toBe(false);
  });

  it("orders top-level skills before groups, each alphabetically by name", () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", "Atlas-skill"), { name: "atlas", description: "a" });
    writeSkill(join(opts.agentDir, "skills", "Zen-skill"), { name: "zen", description: "z" });
    const inv = buildSkillInventory(opts);
    const root = inv.roots.find((r) => r.sourceRoot === join(opts.agentDir, "skills"));
    const children = root?.children ?? [];
    const kinds = children.map((c) => c.kind);
    const lastSkill = kinds.lastIndexOf("skill");
    const firstGroup = kinds.indexOf("group");
    expect(lastSkill).toBeLessThan(firstGroup);
    const skillNames = children.filter((c) => c.kind === "skill").map((c) => c.name);
    expect(skillNames).toEqual([...skillNames].sort());
    const groupNames = children.filter((c) => c.kind === "group").map((c) => c.name);
    expect(groupNames).toEqual([...groupNames].sort());
  });

  it("disables a single-skill directory with an exact minus rule, never a group glob", async () => {
    const opts = makeOptions();
    writeSkill(join(opts.agentDir, "skills", "Humanizer-zh"), {
      name: "humanizer-zh",
      description: "hz",
    });
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "humanizer-zh"),
      enabled: false,
    });
    const skills = readJson(join(opts.agentDir, "settings.json")).skills as string[];
    expect(skills).toContain("-skills/Humanizer-zh");
    expect(skills.some((s) => s.startsWith("!skills/Humanizer-zh"))).toBe(false);
  });
});

// ── Mutation ──────────────────────────────────────────────────────────

function skillTarget(inv: SkillInventory, name: string) {
  return { kind: "skill" as const, id: findSkill(inv, name).id };
}

function groupTarget(inv: SkillInventory, groupRel: string) {
  const g = findGroup(inv, groupRel);
  if (!g) throw new Error(`no group ${groupRel}`);
  return { kind: "group" as const, id: g.id };
}

function mutationBase(opts: BuildSkillInventoryOptions): MutateSkillEnabledOptions {
  return { ...opts, target: { kind: "skill", id: "" }, enabled: false };
}

describe("mutation: atomic settings patches", () => {
  it("disables one skill with an exact minus rule while preserving other JSON keys", async () => {
    const opts = makeOptions({
      globalSettings: { thinkingLevel: "high", skills: ["!skills/other/**"] },
    });
    const inv = buildSkillInventory(opts);
    const result = await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    expect(readJson(join(opts.agentDir, "settings.json"))).toEqual({
      thinkingLevel: "high",
      skills: ["!skills/other/**", "-skills/baoyu-skills/baoyu-diagram"],
    });
    expect(result.runtimeRestartRequired).toBe(true);
  });

  it("enables a child still excluded by its group through exactly one plus rule", async () => {
    const opts = makeOptions({
      globalSettings: { skills: ["!skills/baoyu-skills/**"] },
    });
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: true,
    });
    expect(readJson(join(opts.agentDir, "settings.json")).skills).toEqual([
      "!skills/baoyu-skills/**",
      "+skills/baoyu-skills/baoyu-diagram",
    ]);
  });

  it("disables a group with a skills-prefixed glob and removes its child plus exceptions", async () => {
    const opts = makeOptions({
      globalSettings: { skills: ["+skills/baoyu-skills/baoyu-diagram", "!skills/unrelated/**"] },
    });
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: groupTarget(inv, "skills/baoyu-skills"),
      enabled: false,
    });
    expect(readJson(join(opts.agentDir, "settings.json")).skills).toEqual([
      "!skills/unrelated/**",
      "!skills/baoyu-skills/**",
    ]);
  });

  it("enables a group under a broader exclusion and force-includes still-matched members", async () => {
    const opts = makeOptions({
      globalSettings: { skills: ["!skills/**", "-skills/baoyu-skills/baoyu-article-illustrator"] },
    });
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: groupTarget(inv, "skills/baoyu-skills"),
      enabled: true,
    });
    const skills = readJson(join(opts.agentDir, "settings.json")).skills as string[];
    expect(skills).toContain("!skills/**");
    expect(skills).toContain("-skills/baoyu-skills/baoyu-article-illustrator"); // child - preserved
    expect(skills).toContain("+skills/baoyu-skills/baoyu-diagram");
    expect(skills).toContain("+skills/baoyu-skills/baoyu-infographic");
    expect(skills).not.toContain("+skills/baoyu-skills/baoyu-article-illustrator"); // - wins, no +
  });

  it("is idempotent on repeated disable", async () => {
    const opts = makeOptions();
    const inv = buildSkillInventory(opts);
    const target = skillTarget(inv, "baoyu-diagram");
    const base = { ...mutationBase(opts), target, enabled: false };
    await mutateSkillEnabled(base);
    await mutateSkillEnabled(base);
    expect(readJson(join(opts.agentDir, "settings.json")).skills).toEqual([
      "-skills/baoyu-skills/baoyu-diagram",
    ]);
  });

  it("rejects mutation of an untrusted project", async () => {
    const opts = makeOptions({ scope: "project", projectTrusted: false });
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: { kind: "skill", id: "/nonexistent/SKILL.md" },
        enabled: false,
      }),
    ).rejects.toThrow(/not trusted/);
  });

  it("does not overwrite settings when the file is invalid JSON", async () => {
    const opts = makeOptions();
    const settingsPath = join(opts.agentDir, "settings.json");
    const malformed = "{ not json";
    writeFileSync(settingsPath, malformed);
    const inv = buildSkillInventory(opts);
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: skillTarget(inv, "baoyu-diagram"),
        enabled: false,
      }),
    ).rejects.toThrow();
    expect(readFileSync(settingsPath, "utf-8")).toBe(malformed);
  });

  it("rejects an unknown target id", async () => {
    const opts = makeOptions();
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: { kind: "skill", id: "/does/not/exist/SKILL.md" },
        enabled: false,
      }),
    ).rejects.toThrow(/Unknown skill target/);
  });

  it("rejects a skill that does not belong to the selected scope", async () => {
    const opts = makeOptions({ scope: "global", projectTrusted: true });
    const inv = buildSkillInventory(opts);
    const projectSkill = flatItems(inv).find((i) => i.scope === "project");
    expect(projectSkill).toBeDefined();
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: { kind: "skill", id: projectSkill?.id ?? "" },
        enabled: false,
      }),
    ).rejects.toThrow(/scope/);
  });

  it("rejects mutation of a cross-root ambiguous target", async () => {
    const opts = makeOptions();
    // Plant a second root whose skill shares the same base-relative path,
    // so one portable rule would hit both roots.
    const home = (opts as { homeDir: string }).homeDir;
    writeSkill(join(home, ".agents", "skills", "baoyu-skills", "baoyu-diagram"), {
      name: "baoyu-diagram",
      description: "dup path",
    });
    const inv = buildSkillInventory(opts);
    const ambiguous = flatItems(inv).find((i) => i.ambiguous);
    expect(ambiguous).toBeDefined();
    await expect(
      mutateSkillEnabled({
        ...mutationBase(opts),
        target: { kind: "skill", id: ambiguous?.id ?? "" },
        enabled: false,
      }),
    ).rejects.toThrow(/ambiguous/);
  });

  it("mutates project skills even when the project has no .pi/ directory yet", async () => {
    const opts = makeOptions({ scope: "project", projectTrusted: true });
    // Remove the whole .pi/ directory to model Dr. Lin's case (project has
    // only ancestor .agents skills, no .pi/ at all).
    rmSync(join(opts.cwd, ".pi"), { recursive: true, force: true });
    writeSkill(join(opts.cwd, ".agents", "skills", "ag", "ag-skill"), {
      name: "ag-skill",
      description: "ag",
    });
    const inv = buildSkillInventory(opts);
    const item = flatItems(inv).find((i) => i.name === "ag-skill");
    expect(item).toBeDefined();
    await mutateSkillEnabled({
      ...mutationBase(opts),
      scope: "project",
      target: { kind: "skill", id: item?.id ?? "" },
      enabled: false,
    });
    expect(existsSync(join(opts.cwd, ".pi", "settings.json"))).toBe(true);
    expect(readJson(join(opts.cwd, ".pi", "settings.json")).skills).toEqual([
      "-skills/ag/ag-skill",
    ]);
    // Lock uses the Pi-compatible settings.json.lock directory, not the old
    // .picot.lock file; both are cleaned up after a successful mutation.
    expect(existsSync(join(opts.cwd, ".pi", "settings.json.picot.lock"))).toBe(false);
    expect(existsSync(join(opts.cwd, ".pi", "settings.json.lock"))).toBe(false);
  });

  it("recovers from a stale settings lock left by a crashed holder", async () => {
    const opts = makeOptions();
    const settingsPath = join(opts.agentDir, "settings.json");
    const lockDir = `${settingsPath}.lock`;
    // Pre-create the Pi-compatible lock directory with an old mtime (>10s stale).
    mkdirAsync(lockDir);
    const old = new Date(Date.now() - 20000);
    await utimes(lockDir, old, old);
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    // Mutation cleared the stale lock, ran, and released its own lock.
    expect(existsSync(lockDir)).toBe(false);
    expect(readJson(settingsPath).skills).toEqual(["-skills/baoyu-skills/baoyu-diagram"]);
  });

  it("waits for a concurrently held lock and succeeds once released", async () => {
    const opts = makeOptions();
    const settingsPath = join(opts.agentDir, "settings.json");
    const lockDir = `${settingsPath}.lock`;
    const inv = buildSkillInventory(opts);
    // Hold the Pi-compatible lock directory from outside the mutation.
    await mkdirAsync(lockDir);
    let released = false;
    const releaser = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await rmdirAsync(lockDir);
        released = true;
        resolve();
      }, 120);
    });
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    expect(released).toBe(true);
    expect(readJson(settingsPath).skills).toEqual(["-skills/baoyu-skills/baoyu-diagram"]);
    await releaser;
  });

  it("migrates a legacy skills object and preserves enableSkillCommands", async () => {
    const opts = makeOptions({
      globalSettings: {
        skills: { enableSkillCommands: false, customDirectories: ["/custom/dir"] },
      } as never,
    });
    const settingsPath = join(opts.agentDir, "settings.json");
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    const result = readJson(settingsPath);
    // enableSkillCommands promoted to top level, not silently dropped.
    expect(result.enableSkillCommands).toBe(false);
    // skills is now an array (migrated customDirectories + the new minus rule),
    // never the old object shape.
    expect(Array.isArray(result.skills)).toBe(true);
    expect(result.skills).toContain("-skills/baoyu-skills/baoyu-diagram");
  });

  it("writes atomically (no .tmp file left behind)", async () => {
    const opts = makeOptions();
    const inv = buildSkillInventory(opts);
    await mutateSkillEnabled({
      ...mutationBase(opts),
      target: skillTarget(inv, "baoyu-diagram"),
      enabled: false,
    });
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(opts.agentDir).filter((f) => f.includes(".picot-skills-"));
    expect(leftovers).toEqual([]);
    expect(existsSync(join(opts.agentDir, "settings.json"))).toBe(true);
  });
});

// ── Task 6: Claude Code skill root discovery ───────────────────────────

describe("Claude Code discovery", () => {
  it("discovers global Claude skills under homeDir/.claude/skills", () => {
    const opts = makeOptions();
    writeSkill(join(opts.homeDir, ".claude", "skills", "claude-skill"), {
      name: "claude-skill",
      description: "a",
    });
    const inv = buildSkillInventory(opts);
    const skill = flatItems(inv).find((i) => i.name === "claude-skill");
    expect(skill).toBeDefined();
    expect(skill?.sourceRoot).toBe(join(opts.homeDir, ".claude", "skills"));
    expect(skill?.scope).toBe("user");
  });

  it("discovers project Claude skills under cwd/.claude/skills when trusted", () => {
    const opts = makeOptions({ projectTrusted: true });
    writeSkill(join(opts.cwd, ".claude", "skills", "proj-claude"), {
      name: "proj-claude",
      description: "b",
    });
    const inv = buildSkillInventory(opts);
    const skill = flatItems(inv).find((i) => i.name === "proj-claude");
    expect(skill).toBeDefined();
    expect(skill?.sourceRoot).toBe(join(opts.cwd, ".claude", "skills"));
  });

  it("does not fabricate Claude cards when the root is absent", () => {
    const opts = makeOptions();
    const inv = buildSkillInventory(opts);
    const claudeSkills = flatItems(inv).filter((i) => i.sourceRoot.includes(".claude"));
    expect(claudeSkills).toHaveLength(0);
  });

  it("honors Claude-mode discovery parity: ignores hidden, ignore files, and loose .md at root", () => {
    const opts = makeOptions();
    // Hidden .hidden directory under Claude should be skipped.
    writeSkill(join(opts.homeDir, ".claude", "skills", ".hidden", "x"), {
      name: "hidden-x",
      description: "h",
    });
    writeSkill(join(opts.homeDir, ".claude", "skills", "review", "r"), {
      name: "review",
      description: "r",
    });
    // Loose .md at the Claude root must be ignored (agents mode).
    writeFileSync(
      join(opts.homeDir, ".claude", "skills", "loose.md"),
      "---\nname: loose\ndescription: l\n---\n",
    );
    const inv = buildSkillInventory(opts);
    const names = flatItems(inv)
      .map((i) => i.name)
      .filter((n) => n === "review" || n === "loose" || n === "hidden-x");
    expect(names).toEqual(["review"]);
  });

  it("trust gating: untrusted project does not expose Claude candidates or paths", () => {
    const opts = makeOptions({ projectTrusted: false });
    writeSkill(join(opts.cwd, ".claude", "skills", "secret"), {
      name: "secret",
      description: "x",
    });
    const inv = buildSkillInventory(opts);
    const json = JSON.stringify(inv);
    expect(json).not.toContain("secret");
    expect(json).not.toContain(".claude/skills");
  });
});

describe("Claude base separation", () => {
  it("global Claude skills use agentDir as their rule base", () => {
    const opts = makeOptions();
    writeSkill(join(opts.homeDir, ".claude", "skills", "review", "r"), {
      name: "r",
      description: "r",
    });
    const inv = buildSkillInventory(opts);
    const skill = flatItems(inv).find((i) => i.name === "r");
    // The skill is enabled by default (no auto-mapping from bare Pi rules).
    expect(skill?.enabled).toBe(true);
    // The skill's ruleBaseDir is the Pi global base, not the Claude
    // discovery root, so any future !/+/- rule is generated against Pi.
    expect(skill?.ruleBaseDir).toBe(opts.agentDir);
  });

  it("project Claude skills use project .pi base", () => {
    const opts = makeOptions({ projectTrusted: true });
    writeSkill(join(opts.cwd, ".claude", "skills", "review", "r"), {
      name: "r",
      description: "r",
    });
    const inv = buildSkillInventory(opts);
    const skill = flatItems(inv).find((i) => i.name === "r");
    expect(skill?.enabled).toBe(true);
    expect(skill?.ruleBaseDir).toBe(join(opts.cwd, ".pi"));
  });

  it("regression: !skills/review/** stays relative to Pi base, not Claude", () => {
    // A bare !skills/review/** rule (no ../../ prefix) refers to the Pi
    // resource base, not the Claude discovery base. The Claude skill's
    // ruleRelativeDir is computed against agentDir (Pi global base), so it
    // becomes ../../.claude/skills/review, which does NOT match the bare
    // Pi pattern skills/review/**. The Claude skill must therefore remain
    // enabled (no automatic re-mapping).
    const opts = makeOptions();
    writeSkill(join(opts.homeDir, ".claude", "skills", "review", "r"), {
      name: "r",
      description: "r",
    });
    writeJson(join(opts.agentDir, "settings.json"), { skills: ["!skills/review/**"] });
    const inv = buildSkillInventory(opts);
    const skill = flatItems(inv).find((i) => i.name === "r");
    expect(skill).toBeDefined();
    expect(skill?.enabled).toBe(true);
    expect(skill?.matchingRules).not.toContain("!skills/review/**");
  });
});

// ── Task 7: atomic Claude root enablement ────────────────────────────

describe("mutateClaudeSkillRoot — atomic enablement", () => {
  // For Claude tests, place homeDir as the grandparent of agentDir so the
  // recommended relative entry "../../.claude/skills" resolves to homeDir
  // exactly. This mirrors the real layout (homeDir = $HOME, agentDir =
  // $HOME/.pi/agent), where agentDir has the recommended entry resolve to
  // homeDir/.claude/skills.
  function makeClaudeOpts(
    overrides: Partial<BuildSkillInventoryOptions> = {},
  ): BuildSkillInventoryOptions {
    const base = makeOptions(overrides);
    const grandParent = dirname(dirname(base.agentDir));
    return { ...base, homeDir: grandParent, ...overrides };
  }

  it("appends the recommended relative entry to agentDir/settings.json for global", async () => {
    const opts = makeClaudeOpts();
    mkdirSync(join(opts.homeDir, ".claude", "skills"), { recursive: true });
    const result: SkillMutationResult = await mutateClaudeSkillRoot({
      ...opts,
      kind: "claude-global",
    });
    expect(result.runtimeRestartRequired).toBe(true);
    expect(result.inventory).toBeDefined();
    const settings = readJson(join(opts.agentDir, "settings.json"));
    expect(settings.skills).toContain("../../.claude/skills");
  });

  it("appends the recommended relative entry to <cwd>/.pi/settings.json for project", async () => {
    const opts = makeOptions({ projectTrusted: true });
    mkdirSync(join(opts.cwd, ".claude", "skills"), { recursive: true });
    await mutateClaudeSkillRoot({ ...opts, kind: "claude-project" });
    const settings = readJson(join(opts.cwd, ".pi", "settings.json"));
    expect(settings.skills).toContain("../.claude/skills");
  });

  it("exposes display-only source directory, target settings path, and recommended entry in inventory", async () => {
    const opts = makeClaudeOpts();
    mkdirSync(join(opts.homeDir, ".claude", "skills"), { recursive: true });
    writeSkill(join(opts.homeDir, ".claude", "skills", "alpha"), {
      name: "alpha",
      description: "a",
    });
    const result = await mutateClaudeSkillRoot({ ...opts, kind: "claude-global" });
    const claudeRoot = result.inventory.roots.find((r) => r.rootKind === "claude-global");
    expect(claudeRoot).toBeDefined();
    expect(claudeRoot?.recommendedEntry).toBe("../../.claude/skills");
    expect(claudeRoot?.settingsPath).toBe(join(opts.agentDir, "settings.json"));
  });

  it("is canonical-idempotent for an already-registered equivalent relative path", async () => {
    const opts = makeClaudeOpts();
    mkdirSync(join(opts.homeDir, ".claude", "skills"), { recursive: true });
    writeJson(join(opts.agentDir, "settings.json"), { skills: ["../../.claude/skills"] });
    await mutateClaudeSkillRoot({ ...opts, kind: "claude-global" });
    const settings = readJson(join(opts.agentDir, "settings.json"));
    const matches = (settings.skills as string[]).filter((s) => s === "../../.claude/skills");
    expect(matches).toHaveLength(1);
  });

  it("is canonical-idempotent for an absolute path alias", async () => {
    const opts = makeClaudeOpts();
    const home = opts.homeDir;
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    writeJson(join(opts.agentDir, "settings.json"), {
      skills: [join(home, ".claude", "skills")],
    });
    await mutateClaudeSkillRoot({ ...opts, kind: "claude-global" });
    const settings = readJson(join(opts.agentDir, "settings.json"));
    // The absolute alias remains, no duplicate relative path appended.
    expect(settings.skills).toContain(join(home, ".claude", "skills"));
    expect(settings.skills).not.toContain("../../.claude/skills");
  });

  it("is canonical-idempotent for a symlink-aliased root", async () => {
    const opts = makeClaudeOpts();
    const home = opts.homeDir;
    // ~/.claude/skills-real is the real dir; ~/.claude/skills is a symlink to it.
    const realDir = join(home, ".claude", "skills-real");
    mkdirSync(realDir, { recursive: true });
    const linkDir = join(home, ".claude", "skills");
    try {
      symlinkSync(realDir, linkDir, "dir");
    } catch {
      return; // symlink not supported on this platform / without privileges
    }
    // settings.json already points at the real dir via absolute path.
    writeJson(join(opts.agentDir, "settings.json"), { skills: [realDir] });
    await mutateClaudeSkillRoot({ ...opts, kind: "claude-global" });
    const settings = readJson(join(opts.agentDir, "settings.json"));
    // The existing alias resolves to the same canonical root; do not append
    // the recommended relative entry.
    expect(settings.skills).toContain(realDir);
    expect(settings.skills).not.toContain("../../.claude/skills");
  });

  it("rejects unknown kind", async () => {
    const opts = makeOptions();
    await expect(mutateClaudeSkillRoot({ ...opts, kind: "bogus" as never })).rejects.toThrow();
  });

  it("rejects untrusted project", async () => {
    const opts = makeOptions({ projectTrusted: false });
    mkdirSync(join(opts.cwd, ".claude", "skills"), { recursive: true });
    await expect(mutateClaudeSkillRoot({ ...opts, kind: "claude-project" })).rejects.toThrow(
      /not trusted/,
    );
  });

  it("preserves unrelated settings keys, ordinary entries, globs, and !/+/- rules", async () => {
    const opts = makeClaudeOpts();
    mkdirSync(join(opts.homeDir, ".claude", "skills"), { recursive: true });
    writeJson(join(opts.agentDir, "settings.json"), {
      thinkingLevel: "high",
      skills: ["!skills/other/**", "skills/keep"],
    });
    await mutateClaudeSkillRoot({ ...opts, kind: "claude-global" });
    const settings = readJson(join(opts.agentDir, "settings.json"));
    expect(settings.thinkingLevel).toBe("high");
    expect(settings.skills).toContain("!skills/other/**");
    expect(settings.skills).toContain("skills/keep");
    expect(settings.skills).toContain("../../.claude/skills");
  });

  it("serializes concurrent mutations through withSettingsLock", async () => {
    const opts = makeClaudeOpts();
    mkdirSync(join(opts.homeDir, ".claude", "skills"), { recursive: true });
    const a = mutateClaudeSkillRoot({ ...opts, kind: "claude-global" });
    const b = mutateClaudeSkillRoot({ ...opts, kind: "claude-global" });
    await Promise.all([a, b]);
    const settings = readJson(join(opts.agentDir, "settings.json"));
    const matches = (settings.skills as string[]).filter((s) => s === "../../.claude/skills");
    expect(matches).toHaveLength(1);
  });

  it("rejects a missing Claude root", async () => {
    const opts = makeOptions();
    // homeDir/.claude/skills is not created; mutation should fail.
    await expect(mutateClaudeSkillRoot({ ...opts, kind: "claude-global" })).rejects.toThrow();
  });
});
