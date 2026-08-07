// ABOUTME: Tests host-backed per-session profiles and temporary composer drafts.
// ABOUTME: Profiles never use browser storage; drafts stay in the current page instance.
import { describe, expect, test, vi } from "vitest";
import { SessionUiStateStore } from "./session-ui-state.js";

describe("SessionUiStateStore profiles", () => {
  test("stores model and thinking profile independently per session through the host client", async () => {
    const profile = { provider: "openai", modelId: "gpt-5", thinkingLevel: "off" };
    const profileClient = {
      load: vi.fn(async () => profile),
      save: vi.fn(async (savedProfile) => savedProfile),
    };
    const store = new SessionUiStateStore({ profileClient });

    await store.saveProfile({
      provider: "anthropic",
      modelId: "claude-sonnet",
      thinkingLevel: "high",
    });
    await store.saveProfile(profile);

    expect(await store.loadProfile()).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "off",
    });
    expect(profileClient.save).toHaveBeenCalledTimes(2);
  });

  test("does not use browser storage for profiles", async () => {
    const profileClient = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => null),
    };
    const store = new SessionUiStateStore({ profileClient });
    await store.loadProfile();
    await store.saveProfile({
      provider: "p",
      modelId: "m",
      thinkingLevel: "off",
    });
    expect(profileClient.load).toHaveBeenCalledWith();
    expect(profileClient.save).toHaveBeenCalledWith({
      provider: "p",
      modelId: "m",
      thinkingLevel: "off",
    });
  });
});

describe("SessionUiStateStore drafts", () => {
  test("keeps drafts isolated in memory for the lifetime of one store", () => {
    const store = new SessionUiStateStore();

    store.saveDraft("/sessions/a.jsonl", "draft for A");

    expect(store.loadDraft("/sessions/a.jsonl")).toBe("draft for A");
    expect(store.loadDraft("/sessions/b.jsonl")).toBe("");
  });

  test("discards drafts when a new store instance represents a refreshed window", () => {
    const firstPage = new SessionUiStateStore();
    firstPage.saveDraft("/sessions/a.jsonl", "draft from the old page");

    const refreshedPage = new SessionUiStateStore();

    expect(refreshedPage.loadDraft("/sessions/a.jsonl")).toBe("");
  });

  test("clearDraft removes only the selected in-memory draft", () => {
    const store = new SessionUiStateStore();
    store.saveDraft("/sessions/a.jsonl", "draft for A");
    store.saveDraft("/sessions/b.jsonl", "draft for B");

    store.clearDraft("/sessions/a.jsonl");

    expect(store.loadDraft("/sessions/a.jsonl")).toBe("");
    expect(store.loadDraft("/sessions/b.jsonl")).toBe("draft for B");
  });
});
