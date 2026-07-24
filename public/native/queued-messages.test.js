import { describe, expect, it } from "vitest";
import { renderQueuedMessages } from "./queued-messages.js";

describe("queued messages", () => {
  it("hides the container when the queue is empty", () => {
    const container = document.createElement("div");
    container.className = "queued-messages";

    renderQueuedMessages(container, { steering: [], followUp: [] });

    expect(container.classList.contains("hidden")).toBe(true);
    expect(container.children).toHaveLength(0);
  });

  it("renders steering and follow-up messages as text", () => {
    const container = document.createElement("div");
    container.className = "queued-messages hidden";

    renderQueuedMessages(container, {
      steering: ["Use the test fixture"],
      followUp: ["<script>alert('x')</script>"],
    });

    expect(container.classList.contains("hidden")).toBe(false);
    expect(container.querySelectorAll(".queued-msg")).toHaveLength(2);
    expect(container.textContent).toContain("Steering");
    expect(container.textContent).toContain("Use the test fixture");
    expect(container.textContent).toContain("Follow-up");
    expect(container.innerHTML).not.toContain("<script>");
  });
});
