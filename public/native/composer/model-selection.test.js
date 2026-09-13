// ABOUTME: Tests provider-scoped model selection in the composer dropdown.
// ABOUTME: Duplicate model IDs must highlight only the active provider's entry.
import { expect, test } from "vitest";
import { isSelectedModel, splitModelsByScope } from "./model-selection.js";

test("selects only one entry when providers expose the same model ID", () => {
  const models = [
    { provider: "zoom-gpt", id: "gpt-5.6-sol" },
    { provider: "openai", id: "gpt-5.6-sol" },
  ];
  const selection = { provider: "zoom-gpt", modelId: "gpt-5.6-sol" };

  expect(models.filter((model) => isSelectedModel(model, selection))).toEqual([models[0]]);
});

test("orders configured scoped models first without duplicate remaining entries", () => {
  const anthropic = { provider: "anthropic", id: "claude" };
  const openai = { provider: "openai", id: "gpt-5" };
  const google = { provider: "google", id: "gemini" };

  expect(
    splitModelsByScope([anthropic, openai, google], ["google/gemini", "anthropic/claude"]),
  ).toEqual({
    scoped: [google, anthropic],
    remaining: [openai],
  });
});

test("drops scoped ids that are not in the visible model list", () => {
  const openai = { provider: "openai", id: "gpt-5" };

  // A starred model that was later hidden in Settings must not render.
  expect(splitModelsByScope([openai], ["google/gemini"]).scoped).toEqual([]);
  expect(splitModelsByScope([openai], ["google/gemini"]).remaining).toEqual([openai]);
});

test("handles non-array inputs defensively", () => {
  expect(splitModelsByScope(null, ["a/b"])).toEqual({ scoped: [], remaining: [] });
  expect(splitModelsByScope([], null)).toEqual({ scoped: [], remaining: [] });
});
