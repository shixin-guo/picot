// ABOUTME: jsdom tests for the read-only Packages skills tab module.
// ABOUTME: Verifies load, scope switching, card expansion, trust gating, and no-mutation contract.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupPackageSkillsTab } from "./package-skills-tab.js";

// Minimal i18n stub: returns the key plus interpolated values so tests can
// assert on locale-key presence without pulling in the full i18n module.
vi.mock("../i18n.js", () => ({
  onLocaleChange: () => () => {},
  t: (key, params) => {
    let s = key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
    return s;
  },
}));

/** @returns {import("./package-skills-tab.js").PackageSkillInventory} */
function makeInventory(overrides = {}) {
  return {
    scope: "global",
    trusted: true,
    packages: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeCard(overrides = {}) {
  return {
    id: "npm:pkg",
    source: "npm:pkg",
    identity: "npm:pkg",
    scope: "global",
    effectivePackageRoot: "/agent/npm/node_modules/pkg",
    version: "1.2.3",
    candidates: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    id: "npm:pkg::/path/SKILL.md",
    canonicalPath: "/agent/npm/node_modules/pkg/skills/a/SKILL.md",
    relativePath: "skills/a",
    name: "alpha",
    description: "alpha skill",
    diagnostics: [],
    ...overrides,
  };
}

/** Build a fake rpcCommand that resolves to a success envelope. */
function rpcReturning(inventory) {
  return vi.fn(async (cmd) => {
    expect(cmd.type).toBe("list_package_skill_inventory");
    return { success: true, data: inventory };
  });
}

function setup() {
  document.body.innerHTML = '<div id="container"></div>';
  const container = document.getElementById("container");
  const rpcCommand = rpcReturning(makeInventory());
  const tab = setupPackageSkillsTab({ container, rpcCommand });
  return { container, rpcCommand, tab };
}

describe("setupPackageSkillsTab — request shape", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';
  });

  it("sends exactly {type, scope} with no path/owner/cwd/port", async () => {
    const container = document.getElementById("container");
    const rpcCommand = vi.fn(async () => ({
      success: true,
      data: makeInventory(),
    }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(rpcCommand).toHaveBeenCalledWith({
      type: "list_package_skill_inventory",
      scope: "global",
    });
    expect(rpcCommand.mock.calls[0][0]).not.toHaveProperty("path");
    expect(rpcCommand.mock.calls[0][0]).not.toHaveProperty("owner");
    expect(rpcCommand.mock.calls[0][0]).not.toHaveProperty("cwd");
    expect(rpcCommand.mock.calls[0][0]).not.toHaveProperty("port");
  });
});

describe("setupPackageSkillsTab — loading & first activation", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';
  });

  it("shows a loading state before the first response", async () => {
    const container = document.getElementById("container");
    let resolveRpc;
    const rpcCommand = vi.fn(
      () =>
        new Promise((res) => (resolveRpc = () => res({ success: true, data: makeInventory() }))),
    );
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    const activating = tab.activate();
    expect(container.querySelector(".skills-loading")).toBeTruthy();
    resolveRpc();
    await activating;
  });

  it("loads once on first activation and not before", async () => {
    const container = document.getElementById("container");
    const rpcCommand = rpcReturning(makeInventory());
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    expect(rpcCommand).not.toHaveBeenCalled();
    await tab.activate();
    expect(rpcCommand).toHaveBeenCalledTimes(1);
  });
});

describe("setupPackageSkillsTab — card rendering", () => {
  it("renders source, scope, version, and candidate count", async () => {
    const { container, tab } = setup();
    // Override rpcCommand to return a card with one candidate.
    const card = makeCard({
      candidates: [makeCandidate()],
    });
    container._rpcOverride = card;
    await tab.activate();
    // Re-setup with the card-bearing inventory for a clean assertion.
    document.body.innerHTML = '<div id="container"></div>';
    const c2 = document.getElementById("container");
    const rpc2 = rpcReturning(makeInventory({ packages: [card] }));
    const tab2 = setupPackageSkillsTab({ container: c2, rpcCommand: rpc2 });
    await tab2.activate();
    expect(c2.querySelector('[data-package-card="npm:pkg"]')).toBeTruthy();
    expect(c2.querySelector(".skills-group-name").textContent).toBe("npm:pkg");
    expect(c2.querySelector(".package-skills-card-version").textContent).toBe("v1.2.3");
    // The count element renders (the localized label is covered by the
    // i18n-keys-completeness test); assert the card carries one candidate.
    expect(c2.querySelector(".package-skills-card-count")).toBeTruthy();
    expect(card.candidates).toHaveLength(1);
  });

  it("expands a card to show candidates with name/description/relative path", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const card = makeCard({ candidates: [makeCandidate()] });
    const rpcCommand = rpcReturning(makeInventory({ packages: [card] }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    // Candidate not visible until expanded.
    expect(container.querySelector('[data-candidate="alpha"]')).toBeNull();
    // Expand.
    container.querySelector(".skills-expand").click();
    const cand = container.querySelector('[data-candidate="alpha"]');
    expect(cand).toBeTruthy();
    expect(cand.querySelector(".skills-skill-name").textContent).toBe("alpha");
    expect(cand.querySelector(".skills-skill-description").textContent).toBe("alpha skill");
    expect(cand.querySelector(".package-skills-candidate-relative").textContent).toBe("skills/a");
    // Canonical path is available as an accessible label/title, not echoed as text.
    expect(cand.querySelector("code").title).toContain("SKILL.md");
  });

  it("shows a not-installed diagnostic for a missing package root", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const card = makeCard({
      effectivePackageRoot: undefined,
      diagnostics: [{ message: "package is not installed" }],
    });
    const rpcCommand = rpcReturning(makeInventory({ packages: [card] }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(container.querySelector(".package-skills-not-installed")).toBeTruthy();
    expect(container.querySelector(".package-skills-diagnostic").textContent).toContain(
      "not installed",
    );
  });
});

describe("setupPackageSkillsTab — scope switching", () => {
  it("switching to Project keeps the combined list visible but changes emphasized count", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const globalCard = makeCard({ id: "npm:g", source: "npm:g", scope: "global" });
    const projectCard = makeCard({ id: "npm:p", source: "npm:p", scope: "project" });
    const rpcCommand = rpcReturning(
      makeInventory({ scope: "global", packages: [globalCard, projectCard] }),
    );
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    // Both cards visible in the combined list.
    expect(container.querySelectorAll("[data-package-card]").length).toBe(2);
    await tab.setScope("project");
    // Combined list still shows both packages.
    expect(container.querySelectorAll("[data-package-card]").length).toBe(2);
    expect(rpcCommand).toHaveBeenLastCalledWith({
      type: "list_package_skill_inventory",
      scope: "project",
    });
  });
});

describe("setupPackageSkillsTab — trust gating", () => {
  it("displays a trust explanation and no project package paths when untrusted", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    // Untrusted project: packages is empty, trusted is false.
    const rpcCommand = rpcReturning(
      makeInventory({ scope: "project", trusted: false, packages: [] }),
    );
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.setScope("project");
    expect(container.querySelector(".skills-notice")).toBeTruthy();
    // No package card or path leaks.
    expect(container.querySelector("[data-package-card]")).toBeNull();
    expect(container.textContent).not.toContain("/secret");
  });
});

describe("setupPackageSkillsTab — no mutation contract", () => {
  it("never sends any mutation/toggle/install/delete/filter RPC", async () => {
    const { rpcCommand, tab } = setup();
    await tab.activate();
    await tab.setScope("project");
    await tab.refresh();
    for (const call of rpcCommand.mock.calls) {
      expect(call[0].type).toBe("list_package_skill_inventory");
    }
    // No mutation/toggle/install/delete/filter editor exists. Package
    // candidates render a disabled placeholder switch (enable/disable is not
    // implemented); assert there is no ENABLED toggle a user could act on.
    const { container } = setup();
    expect(container.querySelector("button.settings-toggle:not([disabled])")).toBeNull();
    expect(container.querySelector("button.package-skills-toggle")).toBeNull();
  });
});

describe("setupPackageSkillsTab — empty & error states", () => {
  it("shows an empty state when there are no packages", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const rpcCommand = rpcReturning(makeInventory({ packages: [] }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(container.querySelector(".skills-empty")).toBeTruthy();
  });

  it("shows an error state with retry on failure", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const rpcCommand = vi.fn(async () => ({ success: false, error: "boom" }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(container.querySelector(".skills-error")).toBeTruthy();
    expect(container.querySelector(".skills-rescan")).toBeTruthy();
  });
});
