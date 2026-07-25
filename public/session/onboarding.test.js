import { describe, expect, test } from "vitest";
import { t } from "../i18n/index.js";
import { getOnboardingState } from "./onboarding.js";

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
      canType: false,
      needsProject: true,
      needsModel: false,
      message: t("onboarding.needsProject"),
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
      canType: true,
      needsProject: false,
      needsModel: true,
      message: t("onboarding.needsModel"),
    });
  });

  test("allows typing a draft when model setup is missing", () => {
    expect(
      getOnboardingState({
        hasSessions: true,
        workspacePath: "/tmp/project",
        availableModels: [],
      }).canType,
    ).toBe(true);
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
