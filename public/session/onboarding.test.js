import { beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { getOnboardingState } from "./onboarding.js";

beforeEach(async () => {
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          onboarding: {
            openProject: "Open a project to start chatting.",
            configureKey: "Configure an API key or provider to start chatting.",
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

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
      canType: true,
      needsProject: false,
      needsModel: true,
      message: "Configure an API key or provider to start chatting.",
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
