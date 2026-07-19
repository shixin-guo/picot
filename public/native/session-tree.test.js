import { describe, expect, it, vi } from "vitest";
import { SessionTreeController } from "./session-tree.js";

const target = { workspaceId: "w", sessionId: "s", instanceId: "i" };

describe("SessionTreeController", () => {
  it("loads the complete tree and navigates through the Pi-owned bridge while idle", async () => {
    const runtime = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          response: { data: { tree: [{ entry: { id: "root" } }], leafId: "leaf" } },
        })
        .mockResolvedValueOnce({ response: { success: true } })
        .mockResolvedValueOnce({ sequence: 9, state: { activeLeafId: "root", messages: [] } }),
      snapshot: vi.fn().mockResolvedValue({
        type: "runtime_snapshot",
        target,
        sequence: 9,
        state: { activeLeafId: "root", messages: [] },
      }),
    };
    const controller = new SessionTreeController({ runtime, target, lifecycle: () => "idle" });
    await expect(controller.load()).resolves.toMatchObject({ leafId: "leaf" });
    const snapshot = await controller.navigate("root", {
      summarize: true,
      customInstructions: "Focus on tests",
    });
    expect(runtime.request).toHaveBeenCalledWith(
      {
        type: "prompt",
        message:
          '/picot-navigate-tree {"targetId":"root","summarize":true,"customInstructions":"Focus on tests"}',
      },
      target,
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(snapshot.state.activeLeafId).toBe("root");
  });

  it("requires idle state and preserves the previous tree on cancellation or failure", async () => {
    const runtime = {
      request: vi.fn().mockRejectedValue(new Error("cancelled")),
      snapshot: vi.fn(),
    };
    const busy = new SessionTreeController({ runtime, target, lifecycle: () => "working" });
    await expect(busy.navigate("leaf", { summarize: false })).rejects.toThrow("idle");

    const idle = new SessionTreeController({ runtime, target, lifecycle: () => "idle" });
    idle.hydrate({ tree: [{ entry: { id: "existing" } }], leafId: "existing" });
    await expect(idle.navigate("other", { summarize: false })).rejects.toThrow("cancelled");
    expect(idle.current().leafId).toBe("existing");
  });
});
