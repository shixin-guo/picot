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
        { modelRegistry: registry },
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
