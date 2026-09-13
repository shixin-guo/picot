// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  ModelRuntime: { create: vi.fn() },
  SessionManager: { inMemory: vi.fn(), listAll: vi.fn(), open: vi.fn() },
}));
vi.mock("./session-title", () => ({
  generateTitleForSession: vi.fn().mockResolvedValue("Generated title"),
}));
vi.mock("./ssh-remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssh-remote")>();
  return { ...actual, testSshRemoteConnection: vi.fn() };
});

const tempHomes: string[] = [];

async function loadConfigWithTempHome() {
  const home = mkdtempSync(join(tmpdir(), "picot-config-auth-"));
  tempHomes.push(home);
  vi.resetModules();
  process.env.HOME = home;
  const module = await import("./picot-config.ts");
  return {
    home,
    handlePicotConfig: module.handlePicotConfig,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("picot config default settings operations", () => {
  it("renames a managed historical session through Pi SessionManager", async () => {
    const home = mkdtempSync(join(tmpdir(), "picot-config-session-"));
    tempHomes.push(home);
    const sessionPath = join(home, "session.jsonl");
    writeFileSync(sessionPath, '{"type":"session","id":"s1"}\n', "utf8");
    const appendSessionInfo = vi.fn();
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    vi.mocked(SessionManager.listAll).mockResolvedValue([{ path: sessionPath }] as never);
    vi.mocked(SessionManager.open).mockReturnValue({ appendSessionInfo } as never);
    const { handlePicotConfig } = await loadConfigWithTempHome();

    await expect(
      handlePicotConfig(
        "rename_historical_session",
        { filePath: sessionPath, name: "  Renamed session  " },
        {},
      ),
    ).resolves.toEqual({
      ok: true,
      data: { filePath: realpathSync(sessionPath), name: "Renamed session" },
    });
    expect(SessionManager.open).toHaveBeenCalledWith(realpathSync(sessionPath));
    expect(appendSessionInfo).toHaveBeenCalledWith("Renamed session");
  });

  it("rejects unmanaged historical session paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "picot-config-session-"));
    tempHomes.push(home);
    const sessionPath = join(home, "session.jsonl");
    writeFileSync(sessionPath, '{"type":"session","id":"s1"}\n', "utf8");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    vi.mocked(SessionManager.listAll).mockResolvedValue([] as never);
    const { handlePicotConfig } = await loadConfigWithTempHome();

    await expect(
      handlePicotConfig(
        "rename_historical_session",
        { filePath: sessionPath, name: "Renamed session" },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: "Session is not available." });
    expect(SessionManager.open).not.toHaveBeenCalled();
  });

  it("writes large pasted text into the active workspace scratch directory", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });

    const result = await handlePicotConfig(
      "write_paste_offload",
      { content: "large pasted text" },
      { cwd: workspace },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Paste offload failed");
    const relativePath = (result.data as { path: string }).path;
    expect(relativePath.startsWith(".pi/tmp/paste-")).toBe(true);
    expect(relativePath.endsWith(".txt")).toBe(true);
    expect(readFileSync(join(workspace, relativePath), "utf8")).toBe("large pasted text");
  });

  it("navigates the active session tree through Pi context", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const navigateTree = vi.fn().mockResolvedValue({ cancelled: false });

    await expect(
      handlePicotConfig(
        "navigate_tree",
        { targetId: "entry-2", summarize: false, label: "Resume branch" },
        { navigateTree } as never,
      ),
    ).resolves.toEqual({ ok: true, data: { cancelled: false } });
    expect(navigateTree).toHaveBeenCalledWith("entry-2", {
      summarize: false,
      label: "Resume branch",
    });
  });

  it("rejects navigation without a target entry", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    await expect(
      handlePicotConfig("navigate_tree", {}, { navigateTree: vi.fn() } as never),
    ).resolves.toEqual({ ok: false, error: "targetId is required" });
  });

  it("generates a title from the active persisted session", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    await expect(
      handlePicotConfig(
        "generate_session_title",
        {},
        {
          model: { provider: "test", id: "model" },
          sessionManager: { getSessionFile: () => "/sessions/current.jsonl" },
        },
      ),
    ).resolves.toEqual({ ok: true, data: { title: "Generated title" } });
  });

  it("writes global default thinking level while preserving unknown settings", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const settingsPath = join(home, ".pi", "agent", "settings.json");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ thinkingLevel: "low", unknown: 7 }), "utf8");

    await expect(
      handlePicotConfig("set_default_thinking_level", { level: "medium" }, {}),
    ).resolves.toEqual({
      ok: true,
      data: { level: "medium", scope: "global", path: settingsPath },
    });

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      thinkingLevel: "low",
      unknown: 7,
      defaultThinkingLevel: "medium",
    });
  });

  it("rejects unsupported default thinking levels", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();

    await expect(
      handlePicotConfig("set_default_thinking_level", { level: "turbo" }, {}),
    ).resolves.toEqual({ ok: false, error: "Unsupported thinking level: turbo" });
  });

  it("writes global default auto-compaction while preserving compaction settings", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const settingsPath = join(home, ".pi", "agent", "settings.json");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ compaction: { reserveTokens: 8192 }, unknown: true }),
      "utf8",
    );

    await expect(
      handlePicotConfig("set_default_auto_compaction", { enabled: false }, {}),
    ).resolves.toEqual({ ok: true, data: { enabled: false, scope: "global", path: settingsPath } });

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      compaction: { reserveTokens: 8192, enabled: false },
      unknown: true,
    });
  });
});

describe("picot config skills operations", () => {
  it("lists and mutates global skills through the config command bridge", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const skillDir = join(home, ".pi", "agent", "skills", "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill\n---\n",
      "utf8",
    );

    const listed = await handlePicotConfig("list_skill_inventory", { scope: "global" }, {});

    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("Skill inventory lookup failed");
    const skill = (
      listed.data as { roots: Array<{ children: Array<{ id: string; name: string }> }> }
    ).roots[0].children[0];
    expect(skill.name).toBe("demo-skill");

    await expect(
      handlePicotConfig(
        "set_skill_enabled",
        { scope: "global", target: { kind: "skill", id: skill.id }, enabled: false },
        {},
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"))).toEqual({
      skills: ["-skills/demo-skill"],
    });
  });
});

describe("picot config models operations", () => {
  it("saves models.json even when registry refresh does not finish", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const modelsPath = join(home, ".pi", "agent", "models.json");
    const registry = {
      refresh: vi.fn(() => new Promise(() => undefined)),
    };
    const content = JSON.stringify({ providers: { local: { models: [{ id: "qwen" }] } } });

    vi.useFakeTimers();
    try {
      const result = handlePicotConfig(
        "write_models_config",
        { content },
        { modelRegistry: registry as never },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toEqual({
        ok: true,
        data: { path: modelsPath, refreshed: false },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(registry.refresh).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(modelsPath, "utf8"))).toEqual({
      providers: { local: { models: [{ id: "qwen" }] } },
    });
  });

  it("backs up the previous models.json before overwriting it", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const modelsPath = join(home, ".pi", "agent", "models.json");
    mkdirSync(dirname(modelsPath), { recursive: true });
    writeFileSync(modelsPath, JSON.stringify({ providers: { old: {} } }), "utf8");
    const content = JSON.stringify({ providers: { local: { models: [{ id: "qwen" }] } } });

    await handlePicotConfig("write_models_config", { content }, {});

    // The pre-save content is preserved as a rollback copy.
    expect(JSON.parse(readFileSync(`${modelsPath}.bak`, "utf8"))).toEqual({
      providers: { old: {} },
    });
    // The live file carries the new content.
    expect(JSON.parse(readFileSync(modelsPath, "utf8"))).toEqual({
      providers: { local: { models: [{ id: "qwen" }] } },
    });
  });
});

describe("picot config agent text file operations", () => {
  it("reads a missing AGENTS.md as empty content and reports exists=false", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const agentsMdPath = join(home, ".pi", "agent", "AGENTS.md");

    await expect(handlePicotConfig("read_agents_md", {}, {})).resolves.toEqual({
      ok: true,
      data: { content: "", path: agentsMdPath, exists: false },
    });
  });

  it("round-trips AGENTS.md content without JSON validation", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const agentsMdPath = join(home, ".pi", "agent", "AGENTS.md");

    await expect(
      handlePicotConfig("write_agents_md", { content: "Not JSON: just markdown {" }, {}),
    ).resolves.toEqual({ ok: true, data: { path: agentsMdPath } });

    expect(readFileSync(agentsMdPath, "utf8")).toBe("Not JSON: just markdown {");
    await expect(handlePicotConfig("read_agents_md", {}, {})).resolves.toEqual({
      ok: true,
      data: { content: "Not JSON: just markdown {", path: agentsMdPath, exists: true },
    });
  });

  it("round-trips APPEND_SYSTEM.md content", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const appendPath = join(home, ".pi", "agent", "APPEND_SYSTEM.md");

    await expect(
      handlePicotConfig("write_append_system_md", { content: "Always answer briefly." }, {}),
    ).resolves.toEqual({ ok: true, data: { path: appendPath } });

    expect(readFileSync(appendPath, "utf8")).toBe("Always answer briefly.");
    await expect(handlePicotConfig("read_append_system_md", {}, {})).resolves.toEqual({
      ok: true,
      data: { content: "Always answer briefly.", path: appendPath, exists: true },
    });
  });

  it("rejects non-string content for agent text files", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();

    // The gateway contract resolves with { ok: false, error } for handler
    // failures — it rejects only on transport/timeout errors.
    await expect(handlePicotConfig("write_agents_md", { content: 42 }, {})).resolves.toEqual({
      ok: false,
      error: "content must be a string",
    });
    await expect(
      handlePicotConfig("write_append_system_md", { content: null }, {}),
    ).resolves.toEqual({
      ok: false,
      error: "content must be a string",
    });
  });
});

describe("picot config auth operations", () => {
  it("stores and removes API keys without requiring registry authStorage", async () => {
    vi.stubEnv("HOME", "");
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const authPath = join(home, ".pi", "agent", "auth.json");

    await expect(
      handlePicotConfig("set_api_key", { provider: "openai", apiKey: "sk-test" }, {}),
    ).resolves.toEqual({ ok: true, data: { provider: "openai" } });

    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      openai: { type: "api_key", key: "sk-test" },
    });

    await expect(handlePicotConfig("remove_api_key", { provider: "openai" }, {})).resolves.toEqual({
      ok: true,
      data: { provider: "openai" },
    });

    expect(existsSync(authPath)).toBe(true);
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({});
  });

  it("updates the active registry credential store before refreshing", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const credentials = {
      modify: vi.fn(
        async (_provider: string, _mutate: (store: unknown) => Promise<unknown>) => undefined,
      ),
      delete: vi.fn(async (_provider: string) => undefined),
    };
    const registry = {
      runtime: { credentials },
      refresh: vi.fn(async () => undefined),
    };

    await expect(
      handlePicotConfig(
        "set_api_key",
        { provider: "anthropic", apiKey: "sk-ant-test" },
        {
          modelRegistry: registry as never,
        },
      ),
    ).resolves.toEqual({ ok: true, data: { provider: "anthropic" } });

    expect(credentials.modify).toHaveBeenCalledWith("anthropic", expect.any(Function));
    const [, applyMutation] = credentials.modify.mock.calls[0] ?? [];
    expect(applyMutation).toBeTypeOf("function");
    await expect(applyMutation?.(undefined)).resolves.toEqual({
      type: "api_key",
      key: "sk-ant-test",
    });
    expect(registry.refresh).toHaveBeenCalledTimes(1);

    await expect(
      handlePicotConfig(
        "remove_api_key",
        { provider: "anthropic" },
        {
          modelRegistry: registry as never,
        },
      ),
    ).resolves.toEqual({ ok: true, data: { provider: "anthropic" } });

    expect(credentials.delete).toHaveBeenCalledWith("anthropic");
    expect(registry.refresh).toHaveBeenCalledTimes(2);
  });
});

describe("picot config custom provider operations", () => {
  it("saves a relay provider into models.json and stores the API key", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const credentials = {
      modify: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const registry = {
      runtime: { credentials },
      refresh: vi.fn(async () => undefined),
    };

    const result = await handlePicotConfig(
      "save_custom_provider",
      {
        providerId: "My Relay",
        baseUrl: "https://relay.example.com/v1",
        apiKey: "sk-test",
        protocol: "openai-completions",
        models: [{ id: "gpt-4o-mini", contextWindow: 32768, maxTokens: 4096 }],
      },
      { modelRegistry: registry },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        providerId: "my-relay",
        protocol: "openai-completions",
        modelCount: 1,
        keyStored: true,
      },
    });
    const saved = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8"));
    expect(saved.providers["my-relay"]).toMatchObject({
      baseUrl: "https://relay.example.com/v1",
      api: "openai-completions",
      models: [
        expect.objectContaining({ id: "gpt-4o-mini", contextWindow: 32768, maxTokens: 4096 }),
      ],
    });
    expect(saved.providers["my-relay"].apiKey).toBeUndefined();
    expect(credentials.modify).toHaveBeenCalledWith("my-relay", expect.any(Function));
  });

  it("detects an OpenAI-compatible relay", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "gpt-4o-mini", context_window: 32768 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const result = await handlePicotConfig(
        "detect_custom_provider",
        { baseUrl: "https://relay.example.com/v1", apiKey: "sk-test" },
        {},
      );
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        data: {
          protocol: "openai-completions",
          models: [expect.objectContaining({ id: "gpt-4o-mini" })],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("health-checks custom providers over HTTP instead of creating an agent session", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const registry = {
      getAll: () => [
        {
          provider: "my-relay",
          id: "gpt-4o-mini",
          api: "openai-completions",
          baseUrl: "https://relay.example.com/v1",
        },
      ],
      getAvailable: async () => [{ provider: "my-relay", id: "gpt-4o-mini" }],
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: () => "my-relay",
      refresh: vi.fn(),
      getApiKeyForProvider: async () => "sk-test",
    };
    try {
      const result = await handlePicotConfig(
        "check_model_health",
        { provider: "my-relay", modelId: "gpt-4o-mini" },
        { modelRegistry: registry },
      );
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        data: { results: [expect.objectContaining({ provider: "my-relay", status: "healthy" })] },
      });
      expect(createAgentSession).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("picot config oauth operations", () => {
  it("rejects oauth_logout for providers outside the codex whitelist (design §3)", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

    await expect(handlePicotConfig("oauth_logout", { provider: "anthropic" }, {})).resolves.toEqual(
      { ok: false, error: "Unsupported OAuth provider" },
    );
    await expect(handlePicotConfig("oauth_logout", {}, {})).resolves.toEqual({
      ok: false,
      error: "Unsupported OAuth provider",
    });
    // Rejected before any runtime is constructed — the op surface never
    // forwards a non-codex provider to runtime.logout().
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });
});

describe("picot config ssh remote operations", () => {
  it("requires an active workspace to read config", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    await expect(handlePicotConfig("get_ssh_remote_config", {}, {})).resolves.toEqual({
      ok: false,
      error: "Active workspace is required",
    });
  });

  it("reads the project's sshRemote settings and reports trust state", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    const settingsPath = join(workspace, ".pi", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ sshRemote: { enabled: true, host: "example.com" }, other: 1 }),
      "utf8",
    );

    await expect(
      handlePicotConfig(
        "get_ssh_remote_config",
        {},
        { cwd: workspace, isProjectTrusted: () => false },
      ),
    ).resolves.toEqual({
      ok: true,
      data: {
        config: { enabled: true, host: "example.com" },
        resolved: { enabled: true, host: "example.com" },
        hosts: {},
        trusted: false,
        path: settingsPath,
      },
    });
  });

  it("defaults to a disabled config when the project has no settings.json yet", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });

    await expect(
      handlePicotConfig(
        "get_ssh_remote_config",
        {},
        { cwd: workspace, isProjectTrusted: () => true },
      ),
    ).resolves.toEqual({
      ok: true,
      data: {
        config: { enabled: false, host: "" },
        resolved: { enabled: false, host: "" },
        hosts: {},
        trusted: true,
        path: join(workspace, ".pi", "settings.json"),
      },
    });
  });

  it("rejects writes to an untrusted project", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });

    await expect(
      handlePicotConfig(
        "set_ssh_remote_config",
        { config: { enabled: true, host: "example.com" } },
        { cwd: workspace, isProjectTrusted: () => false },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Project settings cannot be changed until the workspace is trusted",
    });
  });

  it("rejects enabling without a host", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });

    await expect(
      handlePicotConfig(
        "set_ssh_remote_config",
        { config: { enabled: true, host: "" } },
        { cwd: workspace, isProjectTrusted: () => true },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Host is required when SSH remote execution is enabled",
    });
  });

  it("writes sshRemote settings while preserving unrelated project settings", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    const settingsPath = join(workspace, ".pi", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "low" }), "utf8");

    const result = await handlePicotConfig(
      "set_ssh_remote_config",
      { config: { enabled: true, host: "example.com", port: 2222 } },
      { cwd: workspace, isProjectTrusted: () => true },
    );

    expect(result).toEqual({
      ok: true,
      data: { config: { enabled: true, host: "example.com", port: 2222 }, path: settingsPath },
    });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      defaultThinkingLevel: "low",
      sshRemote: { enabled: true, host: "example.com", port: 2222 },
    });
  });

  it("delegates connection testing to testSshRemoteConnection", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    const { testSshRemoteConnection } = await import("./ssh-remote");
    vi.mocked(testSshRemoteConnection).mockResolvedValue({
      ok: true,
      message: "Connected",
      remotePath: "/srv/app",
      latencyMs: 12,
    });

    await expect(
      handlePicotConfig(
        "test_ssh_remote_config",
        { config: { enabled: true, host: "example.com" } },
        {},
      ),
    ).resolves.toEqual({
      ok: true,
      data: { ok: true, message: "Connected", remotePath: "/srv/app", latencyMs: 12 },
    });
    expect(testSshRemoteConnection).toHaveBeenCalledWith({ enabled: true, host: "example.com" });
  });

  it("resolves a hostRef binding against the global registry", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({
        sshHosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu", port: 2222 } },
      }),
      "utf8",
    );
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(
      join(workspace, ".pi", "settings.json"),
      JSON.stringify({ sshRemote: { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" } }),
      "utf8",
    );

    const result = await handlePicotConfig(
      "get_ssh_remote_config",
      {},
      { cwd: workspace, isProjectTrusted: () => true },
    );

    expect(result.ok).toBe(true);
    expect((result as { data: { resolved: unknown } }).data.resolved).toEqual({
      enabled: true,
      host: "10.0.0.5",
      hostRef: "gpu-box",
      port: 2222,
      user: "ubuntu",
      remotePath: "/srv/app",
    });
  });

  it("keeps credentials out of the project file when saving a hostRef binding", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    const settingsPath = join(workspace, ".pi", "settings.json");

    await handlePicotConfig(
      "set_ssh_remote_config",
      {
        config: {
          enabled: true,
          hostRef: "gpu-box",
          host: "10.0.0.5",
          identityFile: "~/.ssh/id_ed25519",
          remotePath: "/srv/app",
        },
      },
      { cwd: workspace, isProjectTrusted: () => true },
    );

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      sshRemote: { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" },
    });
  });

  it("saves and deletes hosts in the global registry", async () => {
    const { home, handlePicotConfig } = await loadConfigWithTempHome();
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const globalPath = join(home, ".pi", "agent", "settings.json");

    await handlePicotConfig(
      "set_ssh_host",
      {
        alias: "gpu-box",
        config: { host: "10.0.0.5", user: "ubuntu", identityFile: "~/.ssh/id_ed25519" },
      },
      {},
    );
    expect(JSON.parse(readFileSync(globalPath, "utf8")).sshHosts).toEqual({
      "gpu-box": { host: "10.0.0.5", user: "ubuntu", identityFile: "~/.ssh/id_ed25519" },
    });

    await expect(handlePicotConfig("get_ssh_hosts", {}, {})).resolves.toMatchObject({
      ok: true,
      data: { hosts: { "gpu-box": { host: "10.0.0.5" } } },
    });

    await handlePicotConfig("delete_ssh_host", { alias: "gpu-box" }, {});
    expect(JSON.parse(readFileSync(globalPath, "utf8")).sshHosts).toEqual({});
  });

  it("rejects a registry entry without a host", async () => {
    const { handlePicotConfig } = await loadConfigWithTempHome();
    await expect(
      handlePicotConfig("set_ssh_host", { alias: "gpu-box", config: { user: "ubuntu" } }, {}),
    ).resolves.toEqual({ ok: false, error: "Host is required" });
  });
});
