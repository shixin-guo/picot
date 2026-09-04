// ABOUTME: Tests provider-scoped model selection in the composer dropdown.
// ABOUTME: Duplicate model IDs must highlight only the active provider's entry.
import { expect, test } from "vitest";
import { isSelectedModel } from "./model-selection.js";

test("selects only one entry when providers expose the same model ID", () => {
  const models = [
    { provider: "zoom-gpt", id: "gpt-5.6-sol" },
    { provider: "openai", id: "gpt-5.6-sol" },
  ];
  const selection = { provider: "zoom-gpt", modelId: "gpt-5.6-sol" };

  expect(models.filter((model) => isSelectedModel(model, selection))).toEqual([models[0]]);
});
