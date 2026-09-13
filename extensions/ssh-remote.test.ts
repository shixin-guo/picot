// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", () => {
  const makeLocalTool = (name: string) => ({
    name,
    label: name,
    description: name,
    parameters: {},
    execute: vi.fn(async () => ({ kind: name, remote: false })),
  });
  const makeFactory = (name: string) =>
    vi.fn((_cwd: string, options?: { operations?: unknown }) =>
      options?.operations
        ? {
            name,
            label: name,
            description: name,
            parameters: {},
            execute: vi.fn(async () => ({ kind: name, remote: true, ops: options.operations })),
          }
        : makeLocalTool(name),
    );
  return {
    createReadTool: makeFactory("read"),
    createWriteTool: makeFactory("write"),
    createEditTool: makeFactory("edit"),
    createBashTool: makeFactory("bash"),
  };
});

import { spawn } from "node:child_process";
import {
  assertSshRemoteSettingsValid,
  createRemoteBashOps,
  createRemoteReadOps,
  createRemoteWriteOps,
  DEFAULT_SSH_REMOTE_SETTINGS,
  listSshRemoteDirectories,
  parseSshConfigHosts,
  parseSshHosts,
  parseSshRemoteSettings,
  readProjectSshRemoteSettings,
  readResolvedProjectSshRemoteSettings,
  registerSshRemoteExtension,
  resolveSshRemoteSettings,
  serializeSshRemoteSettings,
  shQuote,
  sshExec,
  sshTarget,
  testSshRemoteConnection,
} from "./ssh-remote";

type FakeChildOptions = { stdout?: string; stderr?: string; code?: number | null };

function makeFakeChild({ stdout = "", stderr = "", code = 0 }: FakeChildOptions = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn(), write: vi.fn() };
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("parseSshRemoteSettings", () => {
  it("normalizes valid input and drops empty optional fields", () => {
    expect(
      parseSshRemoteSettings({
        enabled: true,
        host: "  example.com  ",
        port: 2222,
        user: " root ",
        remotePath: " /srv/app ",
        identityFile: " ~/.ssh/id_ed25519 ",
      }),
    ).toEqual({
      enabled: true,
      host: "example.com",
      port: 2222,
      user: "root",
      remotePath: "/srv/app",
      identityFile: "~/.ssh/id_ed25519",
    });
  });

  it("never throws and falls back to defaults for garbage input", () => {
    expect(parseSshRemoteSettings(undefined)).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
    expect(parseSshRemoteSettings(null)).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
    expect(parseSshRemoteSettings("nonsense")).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
    expect(parseSshRemoteSettings([1, 2, 3])).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
  });

  it("rejects an out-of-range or non-integer port", () => {
    expect(parseSshRemoteSettings({ host: "h", port: 0 }).port).toBeUndefined();
    expect(parseSshRemoteSettings({ host: "h", port: 70000 }).port).toBeUndefined();
    expect(parseSshRemoteSettings({ host: "h", port: 22.5 }).port).toBeUndefined();
  });
});

describe("serializeSshRemoteSettings / assertSshRemoteSettingsValid", () => {
  it("round-trips through serialize", () => {
    const settings = parseSshRemoteSettings({ enabled: true, host: "h" });
    expect(serializeSshRemoteSettings(settings)).toEqual(settings);
  });

  it("throws when enabled without a host", () => {
    expect(() => assertSshRemoteSettingsValid({ enabled: true, host: "" })).toThrow(/Host/);
  });

  it("allows disabled settings without a host", () => {
    expect(() => assertSshRemoteSettingsValid({ enabled: false, host: "" })).not.toThrow();
  });
});

describe("shQuote / sshTarget", () => {
  it("single-quotes plain values", () => {
    expect(shQuote("/srv/app")).toBe("'/srv/app'");
  });

  it("escapes embedded single quotes so no shell expansion survives", () => {
    // Would be a command-injection vector if interpolated via JSON.stringify()
    // instead: bash still expands `$(...)` inside double quotes.
    expect(shQuote("it's $(rm -rf /)")).toBe("'it'\\''s $(rm -rf /)'");
  });

  it("builds user@host only when a user is set", () => {
    expect(sshTarget({ enabled: true, host: "example.com" })).toBe("example.com");
    expect(sshTarget({ enabled: true, host: "example.com", user: "root" })).toBe(
      "root@example.com",
    );
  });
});

describe("readProjectSshRemoteSettings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the sshRemote block from .pi/settings.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ssh-remote-project-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ sshRemote: { enabled: true, host: "example.com" } }),
      "utf8",
    );
    expect(readProjectSshRemoteSettings(cwd)).toEqual({ enabled: true, host: "example.com" });
  });

  it("returns defaults when settings.json is missing or malformed", () => {
    const missing = mkdtempSync(join(tmpdir(), "ssh-remote-missing-"));
    dirs.push(missing);
    expect(readProjectSshRemoteSettings(missing)).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);

    const malformed = mkdtempSync(join(tmpdir(), "ssh-remote-malformed-"));
    dirs.push(malformed);
    mkdirSync(join(malformed, ".pi"), { recursive: true });
    writeFileSync(join(malformed, ".pi", "settings.json"), "{not json", "utf8");
    expect(readProjectSshRemoteSettings(malformed)).toEqual(DEFAULT_SSH_REMOTE_SETTINGS);
  });
});

describe("sshExec", () => {
  it("resolves stdout and passes BatchMode/ConnectTimeout/host-key flags", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "hello\n" }) as never);
    const result = await sshExec({ enabled: true, host: "example.com", user: "alice" }, "pwd");
    expect(result.toString("utf8")).toBe("hello\n");
    const [bin, args] = vi.mocked(spawn).mock.calls[0];
    expect(bin).toBe("ssh");
    expect(args).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "alice@example.com",
      "pwd",
    ]);
  });

  it("adds -p and -i when port/identityFile are set", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild() as never);
    await sshExec({ enabled: true, host: "example.com", port: 2222, identityFile: "/k/id" }, "pwd");
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(["-p", "2222", "-i", "/k/id", "example.com", "pwd"]),
    );
  });

  it("rejects with stderr on non-zero exit", async () => {
    vi.mocked(spawn).mockReturnValue(
      makeFakeChild({ stderr: "Permission denied", code: 255 }) as never,
    );
    await expect(sshExec({ enabled: true, host: "h" }, "pwd")).rejects.toThrow(
      /exit 255.*Permission denied/s,
    );
  });

  it("pipes input to stdin when provided", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    await sshExec({ enabled: true, host: "h" }, "cat > f", { input: Buffer.from("payload") });
    expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from("payload"));
  });
});

describe("testSshRemoteConnection", () => {
  it("fails fast without spawning when host is empty", async () => {
    const result = await testSshRemoteConnection({ enabled: true, host: "" });
    expect(result).toEqual({ ok: false, message: "Host is required", latencyMs: 0 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports ok with the resolved remote path", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "/srv/app\n" }) as never);
    const result = await testSshRemoteConnection({
      enabled: true,
      host: "h",
      remotePath: "/srv/app",
    });
    expect(result.ok).toBe(true);
    expect(result.remotePath).toBe("/srv/app");
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe("cd '/srv/app' && pwd");
  });

  it("reports the failure message when the connection fails", async () => {
    vi.mocked(spawn).mockReturnValue(
      makeFakeChild({ stderr: "Could not resolve hostname", code: 255 }) as never,
    );
    const result = await testSshRemoteConnection({ enabled: true, host: "nope.invalid" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not resolve hostname/);
  });
});

describe("remote operations factories", () => {
  const settings = { enabled: true, host: "h" };

  it("createRemoteReadOps translates local paths to remote paths", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "content" }) as never);
    const ops = createRemoteReadOps(settings, "/remote/app", "/local/app");
    await ops.readFile("/local/app/src/index.ts");
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe("cat -- '/remote/app/src/index.ts'");
  });

  it("createRemoteWriteOps base64-encodes content over stdin", async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const ops = createRemoteWriteOps(settings, "/remote/app", "/local/app");
    await ops.writeFile("/local/app/out.txt", "hello world");
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe("base64 -d > '/remote/app/out.txt'");
    expect(child.stdin.end).toHaveBeenCalledWith(
      Buffer.from(Buffer.from("hello world").toString("base64")),
    );
  });

  it("createRemoteBashOps prefixes the command with a cd into the mapped cwd", async () => {
    const onData = vi.fn();
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "ok" }) as never);
    const ops = createRemoteBashOps(settings, "/remote/app", "/local/app");
    const result = await ops.exec("ls -la", "/local/app/sub", { onData });
    expect(result).toEqual({ exitCode: 0 });
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect((args as string[]).at(-1)).toBe("cd '/remote/app/sub' && ls -la");
    expect(onData).toHaveBeenCalledWith(Buffer.from("ok"));
  });

  it("createRemoteBashOps kills the child and rejects on abort", async () => {
    const child = makeFakeChild({ code: null });
    vi.mocked(spawn).mockReturnValue(child as never);
    const controller = new AbortController();
    const ops = createRemoteBashOps(settings, "/remote/app", "/local/app");
    const promise = ops.exec("sleep 100", "/local/app", {
      onData: vi.fn(),
      signal: controller.signal,
    });
    controller.abort();
    child.emit("close", null);
    await expect(promise).rejects.toThrow("aborted");
    expect(child.kill).toHaveBeenCalled();
  });
});

describe("registerSshRemoteExtension", () => {
  function createHarness() {
    const registeredTools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }> =
      {};
    const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
    const pi = {
      registerTool: vi.fn((tool: { name: string; execute: (...args: unknown[]) => unknown }) => {
        registeredTools[tool.name] = tool as never;
      }),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
    };
    const trigger = (event: string, ...args: unknown[]) =>
      Promise.all((handlers[event] ?? []).map((handler) => handler(...args)));
    return { pi, registeredTools, trigger };
  }

  function fakeUiCtx(overrides: Record<string, unknown> = {}) {
    return {
      cwd: "/workspace",
      isProjectTrusted: () => true,
      ui: { setStatus: vi.fn(), notify: vi.fn(), theme: { fg: (_: string, text: string) => text } },
      ...overrides,
    };
  }

  it("falls back to the local tool when no settings resolve", async () => {
    const { pi, registeredTools } = createHarness();
    registerSshRemoteExtension(pi as never, () => null);

    const result = await registeredTools.read.execute("id", {}, undefined, undefined, {});
    expect(result).toEqual({ kind: "read", remote: false });
  });

  it("delegates to remote operations once session_start resolves settings", async () => {
    const { pi, registeredTools, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({
      enabled: true,
      host: "example.com",
      remotePath: "/remote/app",
    }));

    const ctx = fakeUiCtx();
    await trigger("session_start", { type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "ssh-remote",
      expect.stringContaining("SSH: example.com:/remote/app"),
    );
    const readResult = (await registeredTools.read.execute("id", {}, undefined, undefined, {})) as {
      remote: boolean;
    };
    expect(readResult.remote).toBe(true);
    const bashResult = (await registeredTools.bash.execute("id", {}, undefined, undefined, {})) as {
      remote: boolean;
    };
    expect(bashResult.remote).toBe(true);
  });

  it("rewrites the system prompt cwd line only while a remote is resolved", async () => {
    const { pi, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({
      enabled: true,
      host: "example.com",
      remotePath: "/remote/app",
    }));
    const localCwd = process.cwd();
    const event = {
      type: "before_agent_start" as const,
      prompt: "hi",
      systemPrompt: `Some header\nCurrent working directory: ${localCwd}\nMore text`,
      systemPromptOptions: {} as never,
    };

    const [beforeUnresolved] = await trigger("before_agent_start", event);
    expect(beforeUnresolved).toBeUndefined();

    await trigger("session_start", { type: "session_start", reason: "startup" }, fakeUiCtx());
    const [resolvedResult] = (await trigger("before_agent_start", event)) as [
      { systemPrompt: string } | undefined,
    ];
    expect(resolvedResult?.systemPrompt).toContain(
      `Current working directory: /remote/app (via SSH: example.com)`,
    );
  });

  it("routes ! user_bash commands to the remote only while resolved", async () => {
    const { pi, trigger } = createHarness();
    registerSshRemoteExtension(pi as never, () => ({
      enabled: true,
      host: "example.com",
      remotePath: "/remote/app",
    }));

    const [unresolved] = await trigger("user_bash", {
      type: "user_bash",
      command: "ls",
      excludeFromContext: false,
      cwd: "/workspace",
    });
    expect(unresolved).toBeUndefined();

    await trigger("session_start", { type: "session_start", reason: "startup" }, fakeUiCtx());
    const [resolved] = (await trigger("user_bash", {
      type: "user_bash",
      command: "ls",
      excludeFromContext: false,
      cwd: "/workspace",
    })) as [{ operations: unknown } | undefined];
    expect(resolved?.operations).toBeDefined();
  });

  it("never applies settings for an untrusted project", async () => {
    const { pi, registeredTools, trigger } = createHarness();
    const resolveSettings = vi.fn(() => ({ enabled: true, host: "example.com" }));
    registerSshRemoteExtension(pi as never, (_cwd, trusted) =>
      trusted ? resolveSettings() : null,
    );

    await trigger(
      "session_start",
      { type: "session_start", reason: "startup" },
      fakeUiCtx({ isProjectTrusted: () => false }),
    );

    const result = await registeredTools.read.execute("id", {}, undefined, undefined, {});
    expect(result).toEqual({ kind: "read", remote: false });
  });

  it("notifies an error and stays local when the initial connection fails", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stderr: "boom", code: 255 }) as never);
    const { pi, registeredTools, trigger } = createHarness();
    // No remotePath: session_start must ssh out to resolve `pwd`, which fails here.
    registerSshRemoteExtension(pi as never, () => ({ enabled: true, host: "example.com" }));

    const ctx = fakeUiCtx();
    await trigger("session_start", { type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("could not connect"),
      "error",
    );
    const result = await registeredTools.read.execute("id", {}, undefined, undefined, {});
    expect(result).toEqual({ kind: "read", remote: false });
  });
});

describe("parseSshHosts", () => {
  it("normalizes a registry and drops entries without a host", () => {
    expect(
      parseSshHosts({
        "gpu-box": { host: " 10.0.0.5 ", user: " ubuntu ", port: 2222, enabled: true },
        broken: { user: "ubuntu" },
        "  ": { host: "10.0.0.6" },
      }),
    ).toEqual({ "gpu-box": { host: "10.0.0.5", port: 2222, user: "ubuntu" } });
  });

  it("reads a non-object as an empty registry", () => {
    expect(parseSshHosts(null)).toEqual({});
    expect(parseSshHosts([1, 2])).toEqual({});
  });
});

describe("resolveSshRemoteSettings", () => {
  const hosts = {
    "gpu-box": { host: "10.0.0.5", user: "ubuntu", port: 2222, identityFile: "~/.ssh/id_ed25519" },
  };

  it("fills the connection in from the referenced host", () => {
    expect(
      resolveSshRemoteSettings(
        { enabled: true, host: "", hostRef: "gpu-box", remotePath: "/srv/app" },
        hosts,
      ),
    ).toEqual({
      enabled: true,
      host: "10.0.0.5",
      hostRef: "gpu-box",
      port: 2222,
      user: "ubuntu",
      remotePath: "/srv/app",
      identityFile: "~/.ssh/id_ed25519",
    });
  });

  it("lets the project override a single field of a shared host", () => {
    const resolved = resolveSshRemoteSettings(
      { enabled: true, host: "", hostRef: "gpu-box", port: 2200 },
      hosts,
    );
    expect(resolved.port).toBe(2200);
    expect(resolved.host).toBe("10.0.0.5");
  });

  it("leaves an inline binding untouched", () => {
    const inline = { enabled: true, host: "example.com" };
    expect(resolveSshRemoteSettings(inline, hosts)).toEqual(inline);
  });

  it("does not invent a connection for an alias that is gone", () => {
    const binding = { enabled: true, host: "", hostRef: "deleted" };
    expect(resolveSshRemoteSettings(binding, hosts)).toEqual(binding);
  });
});

describe("serializeSshRemoteSettings", () => {
  it("stores only the binding when a host alias is used", () => {
    expect(
      serializeSshRemoteSettings({
        enabled: true,
        hostRef: "gpu-box",
        host: "10.0.0.5",
        identityFile: "~/.ssh/id_ed25519",
        remotePath: "/srv/app",
      }),
    ).toEqual({ enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" });
  });
});

describe("parseSshConfigHosts", () => {
  it("reads host blocks, honouring keyword case and = separators", () => {
    expect(
      parseSshConfigHosts(
        [
          "# a comment",
          "Host gpu-box",
          "  HostName 10.0.0.5",
          "  user ubuntu",
          "  Port 2222",
          "  IdentityFile ~/.ssh/id_ed25519",
          "",
          "host plain",
          "",
          "Host wild-*",
          "  HostName ignored.example.com",
          "Host eq",
          "  HostName=10.0.0.9",
        ].join("\n"),
      ),
    ).toEqual([
      {
        alias: "gpu-box",
        host: "10.0.0.5",
        user: "ubuntu",
        port: 2222,
        identityFile: "~/.ssh/id_ed25519",
      },
      { alias: "plain", host: "plain" },
      { alias: "eq", host: "10.0.0.9" },
    ]);
  });

  it("returns nothing for an empty config", () => {
    expect(parseSshConfigHosts("")).toEqual([]);
  });
});

describe("listSshRemoteDirectories", () => {
  it("lists only directories, relative to the resolved path", async () => {
    vi.mocked(spawn).mockReturnValue(
      makeFakeChild({ stdout: "/home/ubuntu\ncode/\nnotes.md\n.config/\n" }) as never,
    );
    await expect(
      listSshRemoteDirectories({ enabled: true, host: "example.com" }, "/home/ubuntu"),
    ).resolves.toEqual({ path: "/home/ubuntu", directories: [".config", "code"] });
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect(args?.at(-1)).toBe("cd '/home/ubuntu' && pwd && ls -1pA");
  });

  it("falls back to the login home when no path is given", async () => {
    vi.mocked(spawn).mockReturnValue(makeFakeChild({ stdout: "/home/ubuntu\n" }) as never);
    await listSshRemoteDirectories({ enabled: true, host: "example.com" });
    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect(args?.at(-1)).toBe('cd "$HOME" && pwd && ls -1pA');
  });

  it("requires a host", async () => {
    await expect(listSshRemoteDirectories({ enabled: true, host: "" })).rejects.toThrow(
      "Host is required",
    );
  });
});

describe("readResolvedProjectSshRemoteSettings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("joins the project binding to the global registry", () => {
    const home = mkdtempSync(join(tmpdir(), "ssh-remote-home-"));
    dirs.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ sshHosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu" } } }),
      "utf8",
    );
    const cwd = join(home, "anchor");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ sshRemote: { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" } }),
      "utf8",
    );

    expect(readResolvedProjectSshRemoteSettings(cwd)).toEqual({
      enabled: true,
      host: "10.0.0.5",
      hostRef: "gpu-box",
      user: "ubuntu",
      remotePath: "/srv/app",
    });
  });
});
