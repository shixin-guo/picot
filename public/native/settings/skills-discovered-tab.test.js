// ABOUTME: Verifies the focused Discovered Skills tab keeps inventory ownership behavior.
// ABOUTME: Covers activation, Claude root enablement payloads, and trust state exposure.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n.js", () => ({
  onLocaleChange: () => () => {},
  t: (key) => key,
}));

import { setupDiscoveredSkillsTab } from "./skills-discovered-tab.js";

function inventory(overrides = {}) {
  return {
    trusted: true,
    roots: [
      {
        sourceRoot: "/home/.claude/skills",
        scope: "user",
        rootKind: "claude-global",
        configuredForPi: false,
        children: [
          { kind: "skill", id: "skill", name: "review", description: "review", status: "enabled" },
        ],
      },
    ],
    customRules: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("Discovered Skills tab", () => {
  let container;
  beforeEach(() => {
    container = document.createElement("div");
  });

  it("loads inventory and exposes trust state", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: inventory() });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(rpcCommand).toHaveBeenCalledWith({ type: "list_skill_inventory", scope: "global" });
    expect(tab.isProjectTrusted()).toBe(true);
  });

  it("cancels Claude root confirmation without mutation", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: inventory() });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    container.querySelector(".skills-add-root").click();
    container.querySelector(".skills-add-root-cancel").click();
    expect(rpcCommand).toHaveBeenCalledTimes(1);
  });

  it("sends only opaque Claude scope and kind to enable the root", async () => {
    const rpcCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: inventory() })
      .mockResolvedValueOnce({ success: true, data: { inventory: inventory({ roots: [] }) } });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    container.querySelector(".skills-add-root").click();
    expect(rpcCommand).toHaveBeenCalledTimes(1);
    container.querySelector(".skills-add-root-confirm").click();
    await vi.waitFor(() => expect(rpcCommand).toHaveBeenCalledTimes(2));
    expect(rpcCommand).toHaveBeenLastCalledWith({
      type: "skill_add_root",
      scope: "global",
      kind: "claude-global",
    });
  });

  it("allows only one Claude root mutation while confirmation is submitting", async () => {
    let resolveMutation;
    const rpcCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: inventory() })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMutation = resolve;
          }),
      );
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    container.querySelector(".skills-add-root").click();
    const confirm = container.querySelector(".skills-add-root-confirm");
    confirm.click();
    confirm.click();
    expect(rpcCommand).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".skills-add-root-confirm").disabled).toBe(true);
    resolveMutation({ success: true, data: { inventory: inventory({ roots: [] }) } });
    await vi.waitFor(() => expect(container.querySelector(".skills-add-root-confirm")).toBeNull());
  });
});
