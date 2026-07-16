import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "./i18n.js";
import {
  buildWorkspaceUrl,
  isDeadPortError,
  startInWindowNewSession,
  startNewProjectChat,
  withBrokerWs,
} from "./workspace-actions.js";

beforeEach(async () => {
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          errors: {
            newSessionFailed: "Failed to start new session",
            newSessionOnlyNative: "New session is only supported with a native host.",
            newChatFailed: "Failed to start new chat",
            openProjectFailed: "Failed to open project",
            openFolderFailed: "Failed to open folder",
            attachWorkspaceFailed: "Failed to attach to workspace",
          },
          sidebar: {
            startingSession: "Starting session…",
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

function makeTransport(newPort = 47826, brokerWsUrl) {
  return {
    newSession: vi.fn().mockResolvedValue(undefined),
    openWorkspace: vi.fn().mockResolvedValue(newPort),
    ...(brokerWsUrl !== undefined ? { brokerWsUrl: () => brokerWsUrl } : {}),
  };
}

describe("startInWindowNewSession parallel-spawn", () => {
  it("waits for health and dismisses the overlay when activating in-place", async () => {
    const transport = makeTransport();
    const dismiss = vi.fn();
    const onBeforeSwap = vi.fn(() => dismiss);
    const onParallelSessionCreated = vi.fn().mockResolvedValue(undefined);

    const ok = await startInWindowNewSession({
      transport,
      getCurrentCwd: () => "/work",
      getCurrentPort: () => 47820,
      navigate: vi.fn(),
      onBeforeSwap,
      shouldSpawnParallel: () => true,
      onParallelSessionCreated,
      renderError: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(transport.openWorkspace).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({ waitForHealth: true, openWindow: false }),
    );
    expect(onParallelSessionCreated).toHaveBeenCalledWith(47826, "/work");
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("cancels a cross-workspace transition when ephemeral settlement is rejected", async () => {
    const transport = makeTransport();
    transport.prepareWorkspaceTarget = vi.fn().mockResolvedValue({
      classification: "cross",
      transitionGeneration: 7,
      targetOrigin: "http://127.0.0.1:47826/",
    });
    transport.commitWorkspaceTransition = vi.fn();
    transport.cancelWorkspaceTransition = vi.fn().mockResolvedValue(undefined);
    const beforeWorkspaceTransition = vi.fn().mockResolvedValue(false);
    const onWorkspaceTransitionCancelled = vi.fn();
    const navigate = vi.fn();

    const ok = await startInWindowNewSession({
      transport,
      getCurrentCwd: () => "/other",
      getCurrentPort: () => 47820,
      navigate,
      onBeforeSwap: vi.fn(),
      shouldSpawnParallel: () => true,
      beforeWorkspaceTransition,
      onWorkspaceTransitionCancelled,
      renderError: vi.fn(),
    });

    expect(ok).toBe(false);
    expect(beforeWorkspaceTransition).toHaveBeenCalled();
    expect(onWorkspaceTransitionCancelled).toHaveBeenCalledTimes(1);
    expect(transport.cancelWorkspaceTransition).toHaveBeenCalledWith(7);
    expect(transport.commitWorkspaceTransition).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("dismisses the overlay and surfaces an error if activation throws", async () => {
    const transport = makeTransport();
    const dismiss = vi.fn();
    const renderError = vi.fn();
    const onParallelSessionCreated = vi.fn().mockRejectedValue(new Error("boom"));

    const ok = await startInWindowNewSession({
      transport,
      getCurrentCwd: () => "/work",
      getCurrentPort: () => 47820,
      navigate: vi.fn(),
      onBeforeSwap: () => dismiss,
      shouldSpawnParallel: () => true,
      onParallelSessionCreated,
      renderError,
    });

    expect(ok).toBe(false);
    expect(renderError).toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalled();
  });

  it("uses in-place new_session when not streaming (no overlay)", async () => {
    const transport = makeTransport();
    const onInPlaceSessionCreated = vi.fn();

    const ok = await startInWindowNewSession({
      transport,
      getCurrentCwd: () => "/work",
      getCurrentPort: () => 47820,
      navigate: vi.fn(),
      onBeforeSwap: vi.fn(),
      shouldSpawnParallel: () => false,
      onInPlaceSessionCreated,
      renderError: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(transport.newSession).toHaveBeenCalledWith(47820);
    expect(transport.openWorkspace).not.toHaveBeenCalled();
    expect(onInPlaceSessionCreated).toHaveBeenCalled();
  });
});

describe("isDeadPortError", () => {
  it("matches the PiManager dead-port error string", () => {
    expect(isDeadPortError("No pi instance on port 47823")).toBe(true);
    expect(isDeadPortError(new Error("No pi instance on port 47823"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isDeadPortError("Connection refused")).toBe(false);
    expect(isDeadPortError(null)).toBe(false);
    expect(isDeadPortError(undefined)).toBe(false);
  });
});

describe("in-place dead-port recovery", () => {
  it("startInWindowNewSession spawns a fresh process when the port is dead", async () => {
    const transport = makeTransport();
    transport.newSession = vi.fn().mockRejectedValue(new Error("No pi instance on port 47823"));
    const onParallelSessionCreated = vi.fn().mockResolvedValue(undefined);
    const onInPlaceSessionCreated = vi.fn();
    const renderError = vi.fn();

    const ok = await startInWindowNewSession({
      transport,
      getCurrentCwd: () => "/work",
      getCurrentPort: () => 47823,
      navigate: vi.fn(),
      onBeforeSwap: vi.fn(),
      shouldSpawnParallel: () => false,
      onInPlaceSessionCreated,
      onParallelSessionCreated,
      renderError,
    });

    expect(ok).toBe(true);
    expect(transport.newSession).toHaveBeenCalledWith(47823);
    expect(transport.openWorkspace).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({ openWindow: false }),
    );
    expect(onParallelSessionCreated).toHaveBeenCalledWith(47826, "/work");
    expect(onInPlaceSessionCreated).not.toHaveBeenCalled();
    expect(renderError).not.toHaveBeenCalled();
  });

  it("startInWindowNewSession surfaces non-dead-port errors without spawning", async () => {
    const transport = makeTransport();
    transport.newSession = vi.fn().mockRejectedValue(new Error("kaboom"));
    const renderError = vi.fn();

    const ok = await startInWindowNewSession({
      transport,
      getCurrentCwd: () => "/work",
      getCurrentPort: () => 47823,
      navigate: vi.fn(),
      onBeforeSwap: vi.fn(),
      shouldSpawnParallel: () => false,
      onInPlaceSessionCreated: vi.fn(),
      renderError,
    });

    expect(ok).toBe(false);
    expect(transport.openWorkspace).not.toHaveBeenCalled();
    expect(renderError).toHaveBeenCalled();
  });

  it("startNewProjectChat spawns a fresh process when the port is dead", async () => {
    const transport = makeTransport();
    transport.newSession = vi.fn().mockRejectedValue(new Error("No pi instance on port 47823"));
    const onParallelSessionCreated = vi.fn().mockResolvedValue(undefined);
    const renderError = vi.fn();

    const ok = await startNewProjectChat({
      project: { path: "/work", sessions: [{ cwd: "/work" }] },
      transport,
      getCurrentPort: () => 47823,
      getCurrentCwd: () => "/work",
      shouldSpawnParallel: () => false,
      onParallelSessionCreated,
      fetchInstances: vi.fn().mockResolvedValue([]),
      navigate: vi.fn(),
      onBeforeSwap: vi.fn(),
      renderError,
    });

    expect(ok).toBe(true);
    expect(onParallelSessionCreated).toHaveBeenCalledWith(47826, "/work");
    expect(renderError).not.toHaveBeenCalled();
  });
});

describe("withBrokerWs", () => {
  it("appends the broker WS url as an encoded query param", () => {
    const transport = { brokerWsUrl: () => "ws://127.0.0.1:47999/broker" };
    expect(withBrokerWs("http://localhost:47826/", transport)).toBe(
      "http://localhost:47826/?brokerWs=ws%3A%2F%2F127.0.0.1%3A47999%2Fbroker",
    );
  });

  it("uses & when the url already has a query string", () => {
    const transport = { brokerWsUrl: () => "ws://x/b" };
    expect(withBrokerWs("http://localhost:47826/?foo=1", transport)).toBe(
      "http://localhost:47826/?foo=1&brokerWs=ws%3A%2F%2Fx%2Fb",
    );
  });

  it("returns the url unchanged when no broker url is available", () => {
    expect(withBrokerWs("http://localhost:47826/", {})).toBe("http://localhost:47826/");
    expect(withBrokerWs("http://localhost:47826/", undefined)).toBe("http://localhost:47826/");
    expect(withBrokerWs("http://localhost:47826/", { brokerWsUrl: () => "" })).toBe(
      "http://localhost:47826/",
    );
  });

  it("survives a throwing brokerWsUrl", () => {
    const transport = {
      brokerWsUrl: () => {
        throw new Error("nope");
      },
    };
    expect(withBrokerWs("http://localhost:47826/", transport)).toBe("http://localhost:47826/");
  });
});

describe("buildWorkspaceUrl", () => {
  it("uses http for per-workspace embedded servers even when current page is https", () => {
    expect(
      buildWorkspaceUrl(47826, {
        location: { protocol: "https:", hostname: "studio.example.test" },
      }),
    ).toBe("http://studio.example.test:47826/");
  });
});

describe("navigation propagates the broker WS url", () => {
  it("startInWindowNewSession appends brokerWs on full-page navigation", async () => {
    const transport = makeTransport(47826, "ws://127.0.0.1:47999/broker");
    const navigate = vi.fn();

    const ok = await startInWindowNewSession({
      transport,
      getCurrentCwd: () => "/work",
      getCurrentPort: () => 47820,
      navigate,
      onBeforeSwap: vi.fn(),
      shouldSpawnParallel: () => true,
      renderError: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith(
      "http://localhost:47826/?brokerWs=ws%3A%2F%2F127.0.0.1%3A47999%2Fbroker",
    );
  });

  it("startNewProjectChat appends brokerWs on full-page navigation", async () => {
    const transport = makeTransport(47826, "ws://127.0.0.1:47999/broker");
    const navigate = vi.fn();

    const ok = await startNewProjectChat({
      project: { path: "/work", sessions: [{ cwd: "/work" }] },
      transport,
      getCurrentPort: () => 47820,
      getCurrentCwd: () => "/other",
      shouldSpawnParallel: () => true,
      fetchInstances: vi.fn().mockResolvedValue([]),
      navigate,
      onBeforeSwap: vi.fn(),
      renderError: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith(
      "http://localhost:47826/?brokerWs=ws%3A%2F%2F127.0.0.1%3A47999%2Fbroker",
    );
  });
});

describe("startNewProjectChat parallel-spawn", () => {
  it("waits for health and dismisses overlay on in-place activation", async () => {
    const transport = makeTransport();
    const dismiss = vi.fn();
    const onParallelSessionCreated = vi.fn().mockResolvedValue(undefined);

    const ok = await startNewProjectChat({
      project: { path: "/work", sessions: [{ cwd: "/work" }] },
      transport,
      getCurrentPort: () => 47820,
      getCurrentCwd: () => "/work",
      shouldSpawnParallel: () => true,
      onParallelSessionCreated,
      fetchInstances: vi.fn().mockResolvedValue([]),
      navigate: vi.fn(),
      onBeforeSwap: () => dismiss,
      renderError: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(transport.openWorkspace).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({ waitForHealth: true }),
    );
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("renderError i18n safety", () => {
  const sourcePath = join(process.cwd(), "public/workspace-actions.js");

  it("has no renderError template literals with raw English text", () => {
    const src = readFileSync(sourcePath, "utf8");
    const lines = src.split("\n");
    const renderErrorLines = lines.filter((l) => l.includes("renderError("));
    expect(renderErrorLines.length).toBeGreaterThan(0);
    // A template literal starting with English text (not ${t(…) or ${variable})
    // is a raw English literal that bypasses i18n.
    const rawEnglishLines = renderErrorLines.filter((line) => /renderError\(`[A-Za-z]/.test(line));
    expect(rawEnglishLines).toEqual([]);
  });

  it('wraps all renderError calls with t("errors.*", …)', () => {
    const src = readFileSync(sourcePath, "utf8");
    const lines = src.split("\n");
    const renderErrorLines = lines.filter((l) => l.includes("renderError("));
    expect(renderErrorLines.length).toBeGreaterThan(0);
    // Every renderError call must use t("errors.…") directly or via the
    // errorLabel variable (which is always assigned from t("errors.…")).
    const unwrapped = renderErrorLines.filter(
      (line) => !line.includes('t("errors.') && !line.includes("errorLabel"),
    );
    expect(unwrapped).toEqual([]);
    // Every errorLabel assignment must derive from t("errors.…").
    const errorLabelLines = lines.filter((l) => /errorLabel\s*[:=]/.test(l));
    expect(errorLabelLines.length).toBeGreaterThan(0);
    const badErrorLabels = errorLabelLines.filter((line) => !line.includes('t("errors.'));
    expect(badErrorLabels).toEqual([]);
  });
});
