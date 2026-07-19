import { describe, expect, test, vi } from "vitest";
import { selectModel } from "./selection.js";

describe("model selection", () => {
  test("updates the local model after a successful runtime switch", async () => {
    const rpcCommand = vi.fn(async () => ({ success: true }));
    const refreshModelInfo = vi.fn();
    const applySelectedModel = vi.fn();
    const model = { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200000 };

    const result = await selectModel({
      model,
      rpcCommand,
      refreshModelInfo,
      applySelectedModel,
    });

    expect(result).toEqual({ success: true });
    expect(rpcCommand).toHaveBeenCalledWith(
      { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" },
      "Switching to sonnet-5…",
    );
    expect(applySelectedModel).toHaveBeenCalledWith(model);
    expect(refreshModelInfo).not.toHaveBeenCalled();
  });

  test("does not update the local model after a failed runtime switch", async () => {
    const rpcCommand = vi.fn(async () => ({ success: false, error: "model unavailable" }));
    const refreshModelInfo = vi.fn();
    const applySelectedModel = vi.fn();

    const result = await selectModel({
      model: { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200000 },
      rpcCommand,
      refreshModelInfo,
      applySelectedModel,
    });

    expect(result).toEqual({ success: false, error: "model unavailable" });
    expect(applySelectedModel).not.toHaveBeenCalled();
    expect(refreshModelInfo).toHaveBeenCalledTimes(1);
  });
});
