import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRemoteMachineSection, loadRemoteMachineSessions } from "./remote-machine-sessions.js";

describe("remote machine sessions", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("loads the federated catalog from the Picot host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ machines: [{ id: "drop", name: "drop.local", sessions: [] }] }),
    });

    await expect(loadRemoteMachineSessions(fetchImpl)).resolves.toEqual([
      { id: "drop", name: "drop.local", sessions: [] },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/v2/remote-sessions", { cache: "no-store" });
  });

  it("renders a machine group and selects its remote session", () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const session = {
      id: "session-1",
      name: "Remote task",
      timestamp: new Date().toISOString(),
      machineId: "drop",
      machineName: "drop.local",
      projectId: "project-1",
      workspaceId: "workspace-1",
      projectPath: "/Users/apple",
    };
    const section = buildRemoteMachineSection(
      [{ id: "drop", name: "drop.local", status: "online", sessions: [session] }],
      { onSelect, onCreate },
    );
    document.body.appendChild(section);

    expect(section.textContent).toContain("drop.local");
    expect(section.textContent).toContain("Remote task");
    section.querySelector(".remote-session-item").click();
    expect(onSelect).toHaveBeenCalledWith(session);
    section.querySelector(".workspace-new-chat-btn").click();
    expect(onCreate).toHaveBeenCalledWith(session);
  });

  it("stays absent when PI WEB has no remote machines", () => {
    expect(buildRemoteMachineSection([])).toBeNull();
  });
});
