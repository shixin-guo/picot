import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpState, reduceAcpEvent } from "./acp-store.js";
import { createSubagentCard } from "./subagent-card.js";

vi.mock("../extensions/dialog.js", () => ({
  showNativeDialog: vi.fn(async () => ({ value: "1. Allow" })),
}));

afterEach(() => {
  for (const el of document.querySelectorAll(".subagent-fullscreen")) el.remove();
});

function baseRun(extra = {}) {
  return {
    id: "run-1",
    taskText: "fix the failing test",
    state: createAcpState(),
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    resultText: "",
    expanded: true,
    ...extra,
  };
}

describe("subagent-card", () => {
  it("renders the task, a running status, and the agent reply as Markdown", () => {
    const run = baseRun();
    const { element, update } = createSubagentCard({ run });

    expect(element.querySelector(".subagent-card-title").textContent).toContain(
      "fix the failing test",
    );
    expect(element.querySelector(".subagent-card-status").textContent).toBe("Working…");

    run.state = reduceAcpEvent(run.state, {
      type: "acp_session_update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "**on** it" },
        },
      },
    });
    update(run);

    const content = element.querySelector(".message.assistant .message-content");
    expect(content).not.toBeNull();
    expect(content.textContent).toContain("on it");
    expect(content.querySelector("strong")?.textContent).toBe("on");
  });

  it("renders tool calls through Picot's tool card", () => {
    const run = baseRun();
    const { element, update } = createSubagentCard({ run });

    run.state = reduceAcpEvent(run.state, {
      type: "acp_session_update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read src/app.js",
          kind: "read",
          status: "in_progress",
        },
      },
    });
    update(run);
    expect(element.querySelector(".tool-card .tool-name").textContent).toBe("Read src/app.js");

    run.state = reduceAcpEvent(run.state, {
      type: "acp_session_update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "file body" } }],
        },
      },
    });
    update(run);
    const status = element.querySelector(".tool-card .tool-status");
    expect(status.dataset.status).toBe("complete");
    expect(element.querySelector(".tool-card .tool-output").textContent).toContain("file body");
  });

  it("shows the Send-result footer only once settled with result text", () => {
    const run = baseRun();
    const { element, update } = createSubagentCard({ run });
    expect(element.querySelector(".subagent-card-footer").hidden).toBe(true);

    update({ ...run, status: "done", finishedAt: new Date().toISOString(), resultText: "all green" });
    expect(element.querySelector(".subagent-card-footer").hidden).toBe(false);
  });

  it("invokes onSendResult with the settled run when the button is clicked", () => {
    const onSendResult = vi.fn();
    const run = baseRun({ status: "done", resultText: "done deal", finishedAt: new Date().toISOString() });
    const { element } = createSubagentCard({ run, onSendResult });

    element.querySelector(".subagent-card-send").dispatchEvent(new Event("click", { bubbles: true }));
    expect(onSendResult).toHaveBeenCalledTimes(1);
    expect(element.querySelector(".subagent-card-send").disabled).toBe(true);
  });

  it("labels the card with the run's agent", () => {
    const run = baseRun({ agentLabel: "Codex" });
    const { element } = createSubagentCard({ run });
    expect(element.querySelector(".subagent-card-title").textContent).toBe(
      "Codex · fix the failing test",
    );
  });

  it("toggles expansion on header click", () => {
    const run = baseRun({ expanded: false });
    const { element } = createSubagentCard({ run });
    expect(element.classList.contains("expanded")).toBe(false);
    element
      .querySelector(".subagent-card-toggle")
      .dispatchEvent(new Event("click", { bubbles: true }));
    expect(element.classList.contains("expanded")).toBe(true);
  });

  it("opens a fullscreen overlay showing the result and closes it", () => {
    const run = baseRun({
      status: "done",
      resultText: "**the** answer",
      finishedAt: new Date().toISOString(),
    });
    run.state.blocks.push({ kind: "message", text: "**the** answer" });
    const { element } = createSubagentCard({ run });

    element
      .querySelector(".subagent-card-expand")
      .dispatchEvent(new Event("click", { bubbles: true }));

    const overlay = document.querySelector(".subagent-fullscreen");
    expect(overlay).not.toBeNull();
    const result = overlay.querySelector(".subagent-fullscreen-result .message-content");
    expect(result.textContent).toContain("the answer");
    expect(result.querySelector("strong")?.textContent).toBe("the");

    overlay
      .querySelector(".subagent-fullscreen-close")
      .dispatchEvent(new Event("click", { bubbles: true }));
    expect(document.querySelector(".subagent-fullscreen")).toBeNull();
  });

  it("closes the fullscreen overlay on Escape and on destroy", () => {
    const { element, destroy } = createSubagentCard({ run: baseRun() });
    const openIt = () =>
      element
        .querySelector(".subagent-card-expand")
        .dispatchEvent(new Event("click", { bubbles: true }));

    openIt();
    expect(document.querySelector(".subagent-fullscreen")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".subagent-fullscreen")).toBeNull();

    openIt();
    destroy();
    expect(document.querySelector(".subagent-fullscreen")).toBeNull();
  });

  it("routes a permission request through the dialog and replies once", async () => {
    const onRespondPermission = vi.fn();
    const run = baseRun();
    const { update } = createSubagentCard({ run, onRespondPermission });

    run.state = reduceAcpEvent(run.state, {
      type: "acp_permission_request",
      requestId: "perm-1",
      params: { options: [{ optionId: "allow", name: "Allow" }], toolCall: { title: "Run bash" } },
    });
    update(run);
    update(run); // second render must not present the dialog twice

    await Promise.resolve();
    await Promise.resolve();
    expect(onRespondPermission).toHaveBeenCalledTimes(1);
    expect(onRespondPermission).toHaveBeenCalledWith("perm-1", "allow");
  });
});
