import { describe, expect, it, vi } from "vitest";
import { WindowCloseCoordinator } from "./window-close-coordinator.js";

function participant({ dirty = [], ephemeral = [] } = {}) {
  let state = { dirtyFiles: dirty, ephemeralChats: ephemeral };
  return {
    getCloseRisk: vi.fn(() => state),
    setInteractionLocked: vi.fn(),
    settleCloseRisk: vi.fn(async () => {
      state = { dirtyFiles: [], ephemeralChats: [] };
      return state;
    }),
    cleanupAfterHostClose: vi.fn(),
  };
}

function fakeTransport() {
  return {
    approveWindowClose: vi.fn(async () => undefined),
    cancelWindowClose: vi.fn(async () => undefined),
  };
}

function makeCoordinator({ showSummaryDialog } = {}) {
  const transport = fakeTransport();
  const dialog = vi.fn(async () => "discard");
  const coordinator = new WindowCloseCoordinator({
    transport,
    showSummaryDialog: showSummaryDialog ?? dialog,
  });
  return { coordinator, transport, dialog };
}

describe("WindowCloseCoordinator no-risk path", () => {
  it("approves immediately when no participant reports risk and toggles the lock", async () => {
    const file = participant();
    const { coordinator, transport } = makeCoordinator();
    coordinator.registerParticipant("file", file);
    await coordinator.handleHostCloseRequest("close-1");
    expect(file.setInteractionLocked).toHaveBeenCalledWith(true);
    expect(transport.approveWindowClose).toHaveBeenCalledWith("close-1");
    expect(file.cleanupAfterHostClose).toHaveBeenCalled();
    expect(file.setInteractionLocked).toHaveBeenCalledWith(false);
  });
});

describe("WindowCloseCoordinator risky path", () => {
  it("shows a summary dialog and approves after a discard decision", async () => {
    const file = participant({
      dirty: [{ id: "f1", name: "a.txt" }],
      ephemeral: [
        {
          instanceId: "sc1",
          generation: 1,
          kind: "side-chat",
          hasMessages: true,
          streaming: false,
        },
      ],
    });
    const { coordinator, transport, dialog } = makeCoordinator();
    coordinator.registerParticipant("file", file);
    await coordinator.handleHostCloseRequest("close-2");
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(file.settleCloseRisk).toHaveBeenCalledWith("discard");
    expect(file.cleanupAfterHostClose).toHaveBeenCalled();
    expect(transport.approveWindowClose).toHaveBeenCalledWith("close-2");
  });

  it("cancel does not approve and restores interaction", async () => {
    const file = participant({ dirty: [{ id: "f1", name: "a.txt" }] });
    const { coordinator, transport } = makeCoordinator({
      showSummaryDialog: vi.fn(async () => "cancel"),
    });
    coordinator.registerParticipant("file", file);
    await coordinator.handleHostCloseRequest("close-3");
    expect(transport.approveWindowClose).not.toHaveBeenCalled();
    expect(transport.cancelWindowClose).toHaveBeenCalledWith("close-3");
    expect(file.setInteractionLocked).toHaveBeenCalledWith(false);
    expect(file.cleanupAfterHostClose).not.toHaveBeenCalled();
  });

  it("a repeated close request for the same id does not open a second dialog", async () => {
    const file = participant({ dirty: [{ id: "f1", name: "a.txt" }] });
    let resolveDialog;
    const dialog = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDialog = resolve;
        }),
    );
    const { coordinator, transport } = makeCoordinator({ showSummaryDialog: dialog });
    coordinator.registerParticipant("file", file);
    const first = coordinator.handleHostCloseRequest("close-4");
    const second = coordinator.handleHostCloseRequest("close-4");
    expect(dialog).toHaveBeenCalledTimes(1);
    resolveDialog("discard");
    await Promise.all([first, second]);
    expect(transport.approveWindowClose).toHaveBeenCalledTimes(1);
  });
});

describe("WindowCloseCoordinator risk revalidation", () => {
  it("re-opens the dialog when ephemeral risk expands during file settlement", async () => {
    let state = {
      dirtyFiles: [{ id: "f1", name: "a.txt" }],
      ephemeralChats: [],
    };
    const file = {
      getCloseRisk: vi.fn(() => state),
      setInteractionLocked: vi.fn(),
      settleCloseRisk: vi.fn(async () => {
        // Simulate a Side Chat starting to stream while files settle.
        state = {
          dirtyFiles: [],
          ephemeralChats: [
            {
              instanceId: "sc-new",
              generation: 1,
              kind: "side-chat",
              hasMessages: true,
              streaming: true,
            },
          ],
        };
        return state;
      }),
      cleanupAfterHostClose: vi.fn(),
    };
    const showSummaryDialog = vi.fn(async () => "discard");
    const { coordinator, transport } = makeCoordinator({ showSummaryDialog });
    coordinator.registerParticipant("file", file);
    await coordinator.handleHostCloseRequest("close-expand");
    // Dialog called twice: once for dirty-file risk, once for expanded ephemeral risk.
    expect(showSummaryDialog).toHaveBeenCalledTimes(2);
    expect(transport.approveWindowClose).toHaveBeenCalledWith("close-expand");
    expect(file.cleanupAfterHostClose).toHaveBeenCalled();
  });

  it("does not re-open the dialog when risk is unchanged after settlement", async () => {
    let state = {
      dirtyFiles: [{ id: "f1", name: "a.txt" }],
      ephemeralChats: [
        {
          instanceId: "sc1",
          generation: 1,
          kind: "side-chat",
          hasMessages: true,
          streaming: false,
        },
      ],
    };
    const file = {
      getCloseRisk: vi.fn(() => state),
      setInteractionLocked: vi.fn(),
      settleCloseRisk: vi.fn(async () => {
        state = { dirtyFiles: [], ephemeralChats: state.ephemeralChats };
        return state;
      }),
      cleanupAfterHostClose: vi.fn(),
    };
    const showSummaryDialog = vi.fn(async () => "discard");
    const { coordinator, transport } = makeCoordinator({ showSummaryDialog });
    coordinator.registerParticipant("file", file);
    await coordinator.handleHostCloseRequest("close-stable");
    expect(showSummaryDialog).toHaveBeenCalledTimes(1);
    expect(transport.approveWindowClose).toHaveBeenCalledWith("close-stable");
  });
});

describe("WindowCloseCoordinator global lock", () => {
  it("setGlobalInteractionLock propagates to every participant", () => {
    const a = participant();
    const b = participant();
    const { coordinator } = makeCoordinator();
    coordinator.registerParticipant("a", a);
    coordinator.registerParticipant("b", b);
    coordinator.setGlobalInteractionLock(true);
    expect(a.setInteractionLocked).toHaveBeenCalledWith(true);
    expect(b.setInteractionLocked).toHaveBeenCalledWith(true);
  });
});
