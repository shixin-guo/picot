// ABOUTME: Locks the authenticated skill install scanner's tree, preview, and revision semantics.
// ABOUTME: Verifies opaque IDs, nested groups, selected-root handling, and stale revisions.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSkillInstallPreview,
  type InstallHostSource,
  installSkillLinks,
  isInstallSelectionValid,
  scanSkillInstallSource,
  selectionIds,
} from "./skill-installation.ts";

function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "picot-install-"));
  mkdirSync(join(root, "review", "nested"), { recursive: true });
  mkdirSync(join(root, "summarize"), { recursive: true });
  writeFileSync(
    join(root, "review", "SKILL.md"),
    "---\nname: review\ndescription: review\n---\nbody\n",
  );
  writeFileSync(
    join(root, "summarize", "SKILL.md"),
    "---\nname: summarize\ndescription: summarize\n---\nbody\n",
  );
  writeFileSync(join(root, "review", "nested", "ignored.md"), "not a skill\n");
  return root;
}

function source(root: string): InstallHostSource {
  return { sourceId: "source-opaque", canonicalPath: root, candidateIdKey: "app-secret" };
}

function options(root: string) {
  return { cwd: root, agentDir: join(root, ".pi", "agent"), projectTrusted: true };
}

function firstGroupId(scan: ReturnType<typeof scanSkillInstallSource>): string {
  const group = scan.tree.find((node) => node.kind === "group");
  if (group?.kind !== "group") throw new Error("expected group");
  return group.id;
}

describe("scanSkillInstallSource", () => {
  it("discovers nested skills and emits opaque stable IDs", () => {
    const root = fixture();
    const first = scanSkillInstallSource(source(root), options(root));
    const second = scanSkillInstallSource(source(root), options(root));
    expect(first.tree).toHaveLength(2);
    expect(first.scanRevision).toBe(second.scanRevision);
    expect(first.defaultSelection).toEqual(second.defaultSelection);
    expect(first.defaultSelection.every(({ id }) => !id.includes(root))).toBe(true);
    expect(selectionIds(first)).toEqual(
      new Set([
        ...first.tree.map((node) => node.id),
        ...first.tree.flatMap((node) =>
          node.kind === "group" ? node.children.map((child) => child.id) : [],
        ),
      ]),
    );
  });

  it("changes revision and IDs when a candidate body changes", () => {
    const root = fixture();
    const before = scanSkillInstallSource(source(root), options(root));
    writeFileSync(
      join(root, "review", "SKILL.md"),
      "---\nname: review\ndescription: review\n---\nchanged\n",
    );
    const after = scanSkillInstallSource(source(root), options(root));
    expect(after.scanRevision).not.toBe(before.scanRevision);
    expect(after.defaultSelection).not.toEqual(before.defaultSelection);
  });

  it("handles a source whose root itself is a skill", () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "picot-single-"));
    writeFileSync(join(root, "SKILL.md"), "---\nname: single\ndescription: one\n---\nbody\n");
    const scan = scanSkillInstallSource(source(root), options(root));
    expect(scan.tree).toHaveLength(1);
    expect(scan.tree[0].kind).toBe("skill");
    expect(scan.defaultSelection).toHaveLength(1);
  });

  it("reports invalid selections and deduplicates symlinked roots by canonical path", () => {
    const root = fixture();
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    const scan = scanSkillInstallSource(source(alias), options(root));
    expect(isInstallSelectionValid(scan, scan.defaultSelection)).toBe(true);
    expect(isInstallSelectionValid(scan, [{ kind: "skill", id: "unknown" }])).toBe(false);
  });
});

describe("installSkillLinks", () => {
  it("writes all selected entries atomically and remains idempotent", async () => {
    const root = fixture();
    const context = options(root);
    const scan = scanSkillInstallSource(source(root), context);
    const result = await installSkillLinks({
      source: source(root),
      scope: "global",
      scanRevision: scan.scanRevision,
      selection: scan.defaultSelection,
      context,
    });
    expect(result.settingsChanged).toBe(true);
    expect(result.addedEntries).toHaveLength(2);
    const settingsPath = join(root, ".pi", "agent", "settings.json");
    const firstText = readFileSync(settingsPath, "utf8");
    const repeated = await installSkillLinks({
      source: source(root),
      scope: "global",
      scanRevision: result.scan.scanRevision,
      selection: result.scan.defaultSelection,
      context,
    });
    expect(repeated.settingsChanged).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(firstText);
  });

  it("rejects a stale revision without creating settings", async () => {
    const root = fixture();
    const context = options(root);
    const scan = scanSkillInstallSource(source(root), context);
    writeFileSync(
      join(root, "review", "SKILL.md"),
      "---\nname: review\ndescription: review\n---\nchanged\n",
    );
    await expect(
      installSkillLinks({
        source: source(root),
        scope: "global",
        scanRevision: scan.scanRevision,
        selection: scan.defaultSelection,
        context,
      }),
    ).rejects.toThrow(/rescan/);
    expect(() => readFileSync(join(root, ".pi", "agent", "settings.json"))).toThrow();
  });
});

describe("buildSkillInstallPreview", () => {
  it("reduces a selected group to one relative directory entry", () => {
    const root = fixture();
    const scan = scanSkillInstallSource(source(root), options(root));
    const preview = buildSkillInstallPreview(
      scan,
      "global",
      [{ kind: "group", id: firstGroupId(scan) }],
      options(root),
    );
    expect(preview.additions).toEqual(["../../review"]);
    expect(preview.settingsPath).toBe(join(realpathSync(root), ".pi", "agent", "settings.json"));
  });

  it("serializes a selected skill relative to the project settings base", () => {
    const root = fixture();
    const scan = scanSkillInstallSource(source(root), options(root));
    const selected = scan.defaultSelection.find((item) => item.kind === "skill");
    if (!selected) throw new Error("expected skill");
    const preview = buildSkillInstallPreview(scan, "project", [selected], options(root));
    expect(preview.additions).toHaveLength(1);
    expect(preview.additions[0]).toMatch(/^\.\.\//);
    expect(preview.settingsPath).toBe(join(realpathSync(root), ".pi", "settings.json"));
  });

  it("rejects unknown selections and untrusted project preview", () => {
    const root = fixture();
    const scan = scanSkillInstallSource(source(root), options(root));
    expect(() =>
      buildSkillInstallPreview(scan, "global", [{ kind: "skill", id: "nope" }], options(root)),
    ).toThrow(/selection/);
    expect(() =>
      buildSkillInstallPreview(scan, "project", scan.defaultSelection, {
        ...options(root),
        projectTrusted: false,
      }),
    ).toThrow(/trusted/);
  });

  it("treats legacy skills.customDirectories as already-configured paths", () => {
    // Pi and Picot migrate legacy { skills: { enableSkillCommands, customDirectories } }
    // into skills: string[]. The preview must see the same migrated list, so a
    // source skill directory already listed in customDirectories is reported as
    // skipped, not added. Build the fixture under a realpath-canonical base so
    // macOS /var→/private/var symlink redirection does not desync additions
    // from dedup.
    const root = realpathSync(fixture());
    const opts = { cwd: root, agentDir: join(root, ".pi", "agent"), projectTrusted: true };
    const settingsPath = join(opts.agentDir, "settings.json");
    mkdirSync(opts.agentDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        skills: { enableSkillCommands: false, customDirectories: ["../../review"] },
      }),
    );
    const scan = scanSkillInstallSource(source(root), opts);
    const selected = scan.defaultSelection.find((item) => item.kind === "skill");
    if (!selected) throw new Error("expected skill");
    const preview = buildSkillInstallPreview(scan, "global", [selected], opts);
    expect(preview.additions).toEqual([]);
    expect(preview.skippedEntries).toHaveLength(1);
  });
});
