// Configuration data plane for the native Picot Settings → Configuration tab.
//
// The legacy `embedded-server.ts` served these operations over its own HTTP/WS
// server. In the native architecture there is no such server: the WebView talks
// to the Rust host, which forwards commands to pi over stdio RPC. pi's native
// RPC command set is fixed (see docs/rpc.md) and cannot be extended, so this
// module is invoked through a registered pi command (`/picot-config`) whose
// handler runs immediately without hitting the LLM or session history. Results
// are returned to the WebView via `ctx.ui.notify(JSON)`, correlated by request
// id (see public/native/config-gateway.js).
//
// All model-registry access (catalog, auth status, API keys, visibility,
// health) goes through the live `ctx.modelRegistry` — the same object the old
// embedded-server used — so we never re-implement pi's provider knowledge.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

type ModelHealthStatus = "unknown" | "healthy" | "unhealthy";

type ModelHealth = {
  status: ModelHealthStatus;
  checkedAt?: string;
  latencyMs?: number;
  error?: string;
};

type ModelPreferencesFile = {
  visibility?: Record<string, boolean>;
  health?: Record<string, ModelHealth>;
};

type CatalogModel = {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
};

type CatalogRegistry = {
  getAll: () => CatalogModel[];
  getAvailable: () => CatalogModel[] | Promise<CatalogModel[]>;
  getProviderAuthStatus: (provider: string) => {
    configured?: boolean;
    source?: string;
    label?: string;
  };
  getProviderDisplayName: (provider: string) => string;
  authStorage: {
    set: (provider: string, value: { type: string; key: string }) => void;
    remove: (provider: string) => void;
  };
  refresh: () => void | Promise<void>;
};

export type PicotConfigResult = { ok: true; data?: unknown } | { ok: false; error: string };

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function resolvePiAgentRoot(): string {
  const candidates: string[] = [];
  const add = (value?: string) => {
    if (typeof value === "string" && value.trim()) candidates.push(path.resolve(value.trim()));
  };
  add(process.env.HOME);
  add(process.env.USERPROFILE);
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    add(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`);
  }
  add(os.homedir());
  for (const home of candidates) {
    const candidate = path.join(home, ".pi", "agent");
    if (fs.existsSync(candidate)) return candidate;
  }
  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData.trim()) {
    const roaming = path.join(path.resolve(appData), "pi", "agent");
    if (fs.existsSync(roaming)) return roaming;
  }
  return path.join(candidates[0] || os.homedir(), ".pi", "agent");
}

const PI_AGENT_ROOT = resolvePiAgentRoot();
const MODELS_PREFS_PATH = path.join(PI_AGENT_ROOT, "picot-models.json");
const AGENT_CONFIG_PATH = path.join(PI_AGENT_ROOT, "settings.json");
const MODELS_CONFIG_PATH = path.join(PI_AGENT_ROOT, "models.json");

function modelPreferenceKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function normalizeModelHealth(value: unknown): ModelHealth {
  if (!value || typeof value !== "object") return { status: "unknown" };
  const candidate = value as Partial<ModelHealth>;
  if (candidate.status !== "healthy" && candidate.status !== "unhealthy") {
    return { status: "unknown" };
  }
  const health: ModelHealth = {
    status: candidate.status,
    checkedAt: typeof candidate.checkedAt === "string" ? candidate.checkedAt : undefined,
    latencyMs: typeof candidate.latencyMs === "number" ? candidate.latencyMs : undefined,
  };
  if (typeof candidate.error === "string") health.error = candidate.error;
  return health;
}

function sanitizeHealthError(error: unknown): string {
  const raw = errMessage(error) || "Health check failed";
  return raw
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "bearer [REDACTED]")
    .slice(0, 240);
}

class ModelPreferencesStore {
  readonly path: string;

  constructor(filePath = MODELS_PREFS_PATH) {
    this.path = filePath;
  }

  read(): Required<ModelPreferencesFile> {
    if (!fs.existsSync(this.path)) return { visibility: {}, health: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, "utf8")) as ModelPreferencesFile;
      return {
        visibility:
          parsed.visibility &&
          typeof parsed.visibility === "object" &&
          !Array.isArray(parsed.visibility)
            ? parsed.visibility
            : {},
        health:
          parsed.health && typeof parsed.health === "object" && !Array.isArray(parsed.health)
            ? parsed.health
            : {},
      };
    } catch {
      return { visibility: {}, health: {} };
    }
  }

  write(next: Required<ModelPreferencesFile>): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(next, null, 2), "utf8");
  }

  isVisible(provider: string, modelId: string): boolean {
    return this.read().visibility[modelPreferenceKey(provider, modelId)] !== false;
  }

  setVisibility(provider: string, modelId: string, visible: boolean): void {
    const prefs = this.read();
    prefs.visibility[modelPreferenceKey(provider, modelId)] = visible;
    this.write(prefs);
  }

  getHealth(provider: string, modelId: string): ModelHealth {
    return normalizeModelHealth(this.read().health[modelPreferenceKey(provider, modelId)]);
  }

  setHealth(provider: string, modelId: string, health: ModelHealth): void {
    const prefs = this.read();
    prefs.health[modelPreferenceKey(provider, modelId)] = normalizeModelHealth(health);
    this.write(prefs);
  }
}

async function buildModelCatalog(registry: CatalogRegistry, preferences: ModelPreferencesStore) {
  const allModels = registry.getAll();
  const availableModels = await registry.getAvailable();
  const availableKeys = new Set(
    availableModels
      .filter((model) => model.provider && model.id)
      .map((model) => modelPreferenceKey(model.provider as string, model.id as string)),
  );
  const providerNames = Array.from(
    new Set(allModels.map((model) => model.provider).filter(Boolean)),
  ).sort() as string[];

  return {
    providers: providerNames.map((providerName) => {
      const status = registry.getProviderAuthStatus(providerName);
      return {
        provider: providerName,
        displayName: registry.getProviderDisplayName(providerName),
        configured: Boolean(status.configured),
        source: status.source,
        label: status.label,
        models: allModels
          .filter(
            (model) =>
              model.provider === providerName &&
              model.id &&
              availableKeys.has(modelPreferenceKey(providerName, model.id as string)),
          )
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .map((model) => {
            const modelId = model.id as string;
            return {
              provider: providerName,
              id: modelId,
              name: model.name,
              contextWindow: model.contextWindow,
              available: availableKeys.has(modelPreferenceKey(providerName, modelId)),
              visible: preferences.isVisible(providerName, modelId),
              health: preferences.getHealth(providerName, modelId),
            };
          }),
      };
    }),
  };
}

async function runModelHealthCheck(
  registry: CatalogRegistry & { authStorage?: unknown },
  model: CatalogModel,
  preferences: ModelPreferencesStore,
): Promise<{ provider: string; modelId: string } & ModelHealth> {
  const provider = model.provider as string;
  const modelId = model.id as string;
  const startedAt = Date.now();
  let sawAssistantText = false;
  try {
    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      tools: [],
      sessionManager: SessionManager.inMemory(),
      authStorage: (registry as { authStorage?: unknown }).authStorage,
      modelRegistry: registry,
    } as Parameters<typeof createAgentSession>[0]);
    try {
      const unsubscribe = session.subscribe((event: unknown) => {
        const evt = event as { assistantMessageEvent?: { type?: string; delta?: string } };
        if (
          evt.assistantMessageEvent?.type === "text_delta" &&
          typeof evt.assistantMessageEvent.delta === "string" &&
          evt.assistantMessageEvent.delta.length > 0
        ) {
          sawAssistantText = true;
        }
      });
      try {
        await session.prompt("Reply exactly: OK");
      } finally {
        unsubscribe();
      }
    } finally {
      session.dispose();
    }
    const result: { provider: string; modelId: string } & ModelHealth = {
      provider,
      modelId,
      status: sawAssistantText ? "healthy" : "unhealthy",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: sawAssistantText ? undefined : "No assistant text returned",
    };
    preferences.setHealth(provider, modelId, result);
    return result;
  } catch (e: unknown) {
    const result: { provider: string; modelId: string } & ModelHealth = {
      provider,
      modelId,
      status: "unhealthy",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: sanitizeHealthError(e),
    };
    preferences.setHealth(provider, modelId, result);
    return result;
  }
}

function readConfigFile(filePath: string, fallback: string): { content: string; path: string } {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : fallback;
  return { content, path: filePath };
}

function writeConfigFile(filePath: string, content: unknown): void {
  if (typeof content !== "string") throw new Error("content must be a string");
  JSON.parse(content); // validate before writing
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Dispatch a single Configuration operation. `ctx` is the extension command
// context; `ctx.modelRegistry` provides live provider/model/auth access.
export async function handlePicotConfig(
  op: string,
  params: Record<string, unknown>,
  ctx: { modelRegistry?: CatalogRegistry },
): Promise<PicotConfigResult> {
  const registry = ctx.modelRegistry;
  const preferences = new ModelPreferencesStore();

  const requireRegistry = (): CatalogRegistry => {
    if (!registry) throw new Error("Model registry not ready yet — try again in a moment.");
    return registry;
  };

  try {
    switch (op) {
      case "list_model_catalog": {
        const catalog = await buildModelCatalog(requireRegistry(), preferences);
        return { ok: true, data: catalog };
      }

      case "set_model_visibility": {
        const provider = asString(params.provider);
        const modelId = asString(params.modelId);
        if (!provider || !modelId) throw new Error("provider and modelId are required");
        const visible = params.visible !== false;
        preferences.setVisibility(provider, modelId, visible);
        return { ok: true, data: { provider, modelId, visible } };
      }

      case "check_model_health": {
        const reg = requireRegistry();
        const provider = asString(params.provider);
        const modelId = asString(params.modelId);
        if (!provider) throw new Error("provider is required");
        const availableKeys = new Set(
          (await reg.getAvailable())
            .filter((model) => model.provider && model.id)
            .map((model) => modelPreferenceKey(model.provider as string, model.id as string)),
        );
        const models = reg.getAll().filter((model) => {
          if (model.provider !== provider || !model.id) return false;
          if (modelId) return model.id === modelId;
          return (
            preferences.isVisible(provider, model.id as string) &&
            availableKeys.has(modelPreferenceKey(provider, model.id as string))
          );
        });
        if (models.length === 0) throw new Error("No matching models available for health check");
        const results = [];
        for (const model of models) {
          results.push(await runModelHealthCheck(reg, model, preferences));
        }
        return { ok: true, data: { results } };
      }

      case "set_api_key": {
        const reg = requireRegistry();
        const provider = asString(params.provider);
        const apiKey = asString(params.apiKey);
        if (!provider) throw new Error("provider is required");
        if (!apiKey) throw new Error("apiKey is required");
        reg.authStorage.set(provider, { type: "api_key", key: apiKey });
        await reg.refresh();
        return { ok: true, data: { provider } };
      }

      case "remove_api_key": {
        const reg = requireRegistry();
        const provider = asString(params.provider);
        if (!provider) throw new Error("provider is required");
        reg.authStorage.remove(provider);
        await reg.refresh();
        return { ok: true, data: { provider } };
      }

      case "read_agent_config":
        return { ok: true, data: readConfigFile(AGENT_CONFIG_PATH, "{}") };

      case "write_agent_config": {
        writeConfigFile(AGENT_CONFIG_PATH, params.content);
        return { ok: true, data: { path: AGENT_CONFIG_PATH } };
      }

      case "read_models_config":
        return { ok: true, data: readConfigFile(MODELS_CONFIG_PATH, '{\n  "providers": {}\n}\n') };

      case "write_models_config": {
        const content = params.content;
        if (typeof content !== "string") throw new Error("content must be a string");
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("models.json must be a JSON object");
        }
        if (
          "providers" in parsed &&
          (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))
        ) {
          throw new Error("'providers' must be an object");
        }
        writeConfigFile(MODELS_CONFIG_PATH, content);
        let refreshed = false;
        try {
          if (registry) {
            await registry.refresh();
            refreshed = true;
          }
        } catch {
          // Non-fatal: file is saved; user can /reload or restart.
        }
        return { ok: true, data: { path: MODELS_CONFIG_PATH, refreshed } };
      }

      case "open_external": {
        const url = asString(params.url);
        if (!url) throw new Error("url is required");
        openExternal(url);
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown configuration operation: ${op}` };
    }
  } catch (e: unknown) {
    return { ok: false, error: errMessage(e) };
  }
}

function openExternal(url: string): void {
  const platform = process.platform;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    execFile(command, args, () => {});
  } catch {
    // Best-effort; frontend falls back to window.open.
  }
}
