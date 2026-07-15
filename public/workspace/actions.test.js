import { describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceUrl,
  isDeadPortError,
  startInWindowNewSession,
  startNewProjectChat,
  withBrokerWs,
} from "./actions.js";

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
