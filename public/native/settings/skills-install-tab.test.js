// ABOUTME: Tests the opaque local Skills install tab state machine.
// ABOUTME: Verifies picker cancellation, scanning, selection, trust, and install payloads.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n.js", () => ({
  onLocaleChange: () => () => {},
  t: (key, params) => {
    let value = key;
    if (params)
      for (const [name, item] of Object.entries(params))
        value = value.replace(`{${name}}`, String(item));
    return value;
  },
}));

import { setupSkillsInstallTab } from "./skills-install-tab.js";

const scan = {
  sourceId: "opaque-source",
  scanRevision: "opaque-revision",
  tree: [
    {
      kind: "group",
      id: "group-1",
      name: "Group",
      children: [
        { kind: "skill", id: "skill-1", name: "One", description: "first" },
        { kind: "skill", id: "skill-2", name: "Two", description: "second" },
      ],
    },
  ],
  defaultSelection: [
    { kind: "skill", id: "skill-1" },
    { kind: "skill", id: "skill-2" },
  ],
};

function transport(overrides = {}) {
  return {
    pickSkillSource: vi.fn().mockResolvedValue({ sourceId: "opaque-source" }),
    scanSkillInstallSource: vi.fn().mockResolvedValue(scan),
    installSkillLinks: vi.fn().mockResolvedValue({
      addedEntries: ["../skills"],
      skippedEntries: [],
      runtimeRestartRequired: true,
    }),
    ...overrides,
  };
}

describe("skills install tab", () => {
  let container;
  beforeEach(() => {
    container = document.createElement("div");
  });

  it("returns to idle when the picker is cancelled", async () => {
    const client = transport({ pickSkillSource: vi.fn().mockResolvedValue(null) });
    const tab = setupSkillsInstallTab({
      container,
      transport: client,
      isProjectTrusted: () => true,
    });
    await tab.activate();
    container.querySelector(".skills-install-choose").click();
    await vi.waitFor(() => expect(client.pickSkillSource).toHaveBeenCalled());
    expect(client.scanSkillInstallSource).not.toHaveBeenCalled();
    expect(container.querySelector(".skills-install-tree")).toBeNull();
  });

  it("scans and submits only opaque install authority", async () => {
    const client = transport();
    const tab = setupSkillsInstallTab({
      container,
      transport: client,
      isProjectTrusted: () => true,
    });
    await tab.activate();
    container.querySelector(".skills-install-choose").click();
    await vi.waitFor(() =>
      expect(container.querySelectorAll("[data-install-node]")).toHaveLength(3),
    );
    container.querySelector(".skills-install-review").click();
    expect(client.installSkillLinks).not.toHaveBeenCalled();
    container.querySelector(".skills-install-confirm").click();
    await vi.waitFor(() => expect(client.installSkillLinks).toHaveBeenCalled());
    expect(client.installSkillLinks).toHaveBeenCalledWith({
      sourceId: "opaque-source",
      scope: "global",
      scanRevision: "opaque-revision",
      selection: [
        { kind: "skill", id: "skill-1" },
        { kind: "skill", id: "skill-2" },
      ],
    });
  });

  it("updates group selection and disables untrusted project scope", async () => {
    const client = transport();
    const tab = setupSkillsInstallTab({
      container,
      transport: client,
      isProjectTrusted: () => false,
    });
    await tab.activate();
    container.querySelector(".skills-install-choose").click();
    await vi.waitFor(() =>
      expect(container.querySelector("[data-install-node='group-1']")).not.toBeNull(),
    );
    expect(container.querySelector("[data-scope='project']").disabled).toBe(true);
    const groupInput = container.querySelector("[data-install-node='group-1'] input");
    groupInput.checked = false;
    groupInput.dispatchEvent(new Event("change"));
    expect(container.querySelector(".skills-install-review").disabled).toBe(true);
  });

  it("cancels confirmation without writing", async () => {
    const client = transport();
    const tab = setupSkillsInstallTab({
      container,
      transport: client,
      isProjectTrusted: () => true,
    });
    await tab.activate();
    container.querySelector(".skills-install-choose").click();
    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-review")).not.toBeNull(),
    );
    container.querySelector(".skills-install-review").click();
    container.querySelector(".skills-install-cancel").click();
    expect(client.installSkillLinks).not.toHaveBeenCalled();
    expect(container.querySelector(".skills-install-review")).not.toBeNull();
  });

  it("renders a scan failure", async () => {
    const client = transport({
      scanSkillInstallSource: vi.fn().mockRejectedValue(new Error("scan exploded")),
    });
    const tab = setupSkillsInstallTab({
      container,
      transport: client,
      isProjectTrusted: () => true,
    });
    await tab.activate();
    container.querySelector(".skills-install-choose").click();
    await vi.waitFor(() => expect(container.textContent).toContain("scan exploded"));
  });

  it("disables the choose button while scanning so scans cannot overlap", async () => {
    let resolveScan;
    const client = transport({
      scanSkillInstallSource: vi.fn(() => new Promise((r) => (resolveScan = r))),
    });
    const tab = setupSkillsInstallTab({
      container,
      transport: client,
      isProjectTrusted: () => true,
    });
    await tab.activate();
    const choose = () => container.querySelector(".skills-install-choose");
    choose().click();
    await vi.waitFor(() => expect(client.scanSkillInstallSource).toHaveBeenCalledTimes(1));
    // While scanning, the choose button is disabled, so a second click cannot
    // start an overlapping scan. This is the primary race guard; the monotonic
    // scanSeq counter inside chooseSource is defense-in-depth for any future
    // code path that reaches chooseSource without the button gate.
    expect(choose().disabled).toBe(true);
    choose().click(); // ignored — button is disabled
    expect(client.scanSkillInstallSource).toHaveBeenCalledTimes(1);
    resolveScan(scan);
    await vi.waitFor(() => expect(choose().disabled).toBe(false));
  });
});
