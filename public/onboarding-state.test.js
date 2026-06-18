import { describe, expect, test } from "vitest";
import { getOnboardingState } from "./onboarding-state.js";

describe("onboarding state", () => {
  test("requires a project before the user can query", () => {
    expect(
      getOnboardingState({
        hasSessions: false,
        workspacePath: "",
        availableModels: [{ id: "claude", provider: "anthropic" }],
      }),
    ).toEqual({
      canQuery: false,
      needsProject: true,
      needsModel: false,
      message: "Open a project to start chatting.",
    });
  });

  test("requires model auth or provider config before the user can query", () => {
    expect(
      getOnboardingState({
        hasSessions: true,
        workspacePath: "/tmp/project",
        availableModels: [],
      }),
    ).toEqual({
      canQuery: false,
      needsProject: false,
      needsModel: true,
      message: "Configure an API key or provider to start chatting.",
    });
  });

  test("allows query when a project and model are available", () => {
    expect(
      getOnboardingState({
        hasSessions: false,
        workspacePath: "/tmp/project",
        availableModels: [{ id: "claude", provider: "anthropic" }],
      }).canQuery,
    ).toBe(true);
  });
});
