import { describe, expect, it } from "vitest";
import "../../ui/session-status-pill.js";
import { createSessionStatus } from "./session-status.js";

function t(key) {
  return key;
}

function bindUi(status, extras = {}) {
  const statusPill = document.createElement("picot-session-status");
  const composerCard = document.createElement("div");
  const abortButton = document.createElement("button");
  const sendButton = document.createElement("button");
  abortButton.classList.add("hidden");
  status.bind({
    statusPill,
    composerCard,
    abortButton,
    sendButton,
    hasPending: () => false,
    getSessionId: () => "session-a",
    ...extras,
  });
  return { abortButton, composerCard, sendButton, statusPill };
}

describe("createSessionStatus", () => {
  it("accepts status updates before bind without throwing", () => {
    const status = createSessionStatus({ t });
    expect(() => status.setStatus("working")).not.toThrow();
    expect(() => status.applyHostStatus("Working…")).not.toThrow();
    expect(() => status.renderStatus()).not.toThrow();
    expect(status.getKind()).toBe("working");

    const { abortButton, sendButton, statusPill } = bindUi(status);
    expect(statusPill.label).toBe("status.working");
    expect(abortButton.classList.contains("hidden")).toBe(false);
    expect(sendButton.classList.contains("hidden")).toBe(true);
  });

  it("maps host English status strings to kinds, not translated labels", () => {
    const status = createSessionStatus({ t });
    const { statusPill } = bindUi(status);

    status.applyHostStatus("Working...");
    expect(status.getKind()).toBe("working");
    expect(statusPill.label).toBe("status.working");
    expect(statusPill.kind).toBe("working");

    status.applyHostStatus("Disconnected");
    expect(status.getKind()).toBe("disconnected");
    expect(statusPill.label).toBe("status.disconnected");
    expect(statusPill.kind).toBe("disconnected");

    status.applyHostStatus("Connected");
    expect(status.getKind()).toBe("connected");
    expect(statusPill.label).toBe("status.connected");

    status.applyHostStatus("Compacting context");
    expect(status.getKind()).toBe("custom");
    expect(statusPill.label).toBe("Compacting context");
  });

  it("shows abort when an extension prompt is pending even if not working", () => {
    const status = createSessionStatus({ t });
    const { abortButton, sendButton } = bindUi(status, { hasPending: () => true });
    status.setStatus("connected");
    expect(abortButton.classList.contains("hidden")).toBe(false);
    expect(sendButton.classList.contains("hidden")).toBe(true);
  });
});
