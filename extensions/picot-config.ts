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
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildModelsJsonProviderEntry,
  detectProviderProtocol,
  fetchUpstreamModels,
  type ModelsJsonDocument,
  mergeProviderIntoModelsJson,
  normalizeBaseUrl,
  type ProbeModel,
  type ProviderProtocol,
  resolveProviderId,
  testProviderConnectivity,
} from "./custom-provider-probe";
import {
  createOAuthLoginOperationManager,
  type OAuthOperationEvent,
} from "./oauth-login-operations";
import { buildPackageSkillInventory } from "./package-skill-inventory";
import { writePasteOffloadFile } from "./paste-offload";
import {
  buildTelegramDmConfig,
  buildTelegramDoctorReport,
  getLatestTelegramUpdateId,
  getTelegramBotIdentity,
  observeTelegramPrivateDm,
  type TelegramBotIdentity,
  type TelegramWorkerStatusLike,
} from "./pi-chat-setup";
import { createPiOAuthLoginAdapter } from "./pi-oauth-login-adapter";
import { generateTitleForSession } from "./session-title";
import {
  buildSkillInventory,
  mutateSkillEnabled,
  type SkillScope,
  type SkillTarget,
} from "./skill-inventory";

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
  api?: string;
  baseUrl?: string;
  apiKey?: string;
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
  refresh: () => void | Promise<void>;
  getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
  getApiKeyAndHeaders?: (model: CatalogModel) => Promise<{
    ok?: boolean;
    apiKey?: string;
  }>;
};

const MODEL_REGISTRY_REFRESH_TIMEOUT_MS = 2_000;

// One active Codex login per embedded pi process; the in-memory map is the
// sole operation registry (design §1) — unknown ids resolve to expired.
const oauthLoginManager = createOAuthLoginOperationManager();

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type ConfigContext = {
  modelRegistry?: CatalogRegistry;
  cwd?: string;
  model?: unknown;
  sessionManager?: { getSessionFile: () => string | undefined };
  navigateTree?: (
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ) => Promise<{ cancelled?: boolean } | undefined>;
  /** Stream an OAuth operation event to the initiating request's envelope. */
  oauthNotify?: (event: unknown) => void;
  isProjectTrusted?: () => boolean;
};

type ListedSession = { path?: string };
type JsonObject = Record<string, unknown>;

async function renameHistoricalSession(filePath: unknown, requestedName: unknown) {
  if (typeof filePath !== "string" || typeof requestedName !== "string") {
    throw new Error("Session path and name are required.");
  }
  const name = requestedName.trim();
  if (!name) throw new Error("Session name cannot be empty.");
  if ([...name].length > 200) throw new Error("Session name cannot exceed 200 characters.");
  if (path.extname(filePath).toLowerCase() !== ".jsonl") {
    throw new Error("Session is not available.");
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = fs.realpathSync.native(filePath);
  } catch {
    throw new Error("Session is not available.");
  }
  const sessions = (await SessionManager.listAll()) as ListedSession[];
  const managed = sessions.find((session) => {
    if (typeof session.path !== "string") return false;
    try {
      return fs.realpathSync.native(session.path) === canonicalTarget;
    } catch {
      return false;
    }
  });
  if (!managed) throw new Error("Session is not available.");
  const manager = SessionManager.open(canonicalTarget);
  manager.appendSessionInfo(name);
  return { filePath: canonicalTarget, name };
}

type SkillInventoryMutation = {
  scope?: unknown;
  target?: unknown;
  enabled?: unknown;
};

type ApiKeyCredential = { type: "api_key"; key: string };

type CredentialStoreLike = {
  modify?: (
    provider: string,
    fn: (current: unknown) => Promise<ApiKeyCredential | undefined>,
  ) => Promise<unknown>;
  delete?: (provider: string) => Promise<void>;
  read?: (provider: string) => Promise<unknown>;
};

type RegistryInternals = {
  runtime?: { credentials?: CredentialStoreLike };
  credentials?: CredentialStoreLike;
  authStorage?: {
    set?: (provider: string, value: ApiKeyCredential) => void | Promise<void>;
    remove?: (provider: string) => void | Promise<void>;
  };
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

function resolveHomeDir(): string {
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
  return candidates[0] || os.homedir();
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

const HOME_DIR = resolveHomeDir();
const PI_AGENT_ROOT = resolvePiAgentRoot();
const MODELS_PREFS_PATH = path.join(PI_AGENT_ROOT, "picot-models.json");
const AGENT_CONFIG_PATH = path.join(PI_AGENT_ROOT, "settings.json");
const AGENTS_MD_PATH = path.join(PI_AGENT_ROOT, "AGENTS.md");
const APPEND_SYSTEM_MD_PATH = path.join(PI_AGENT_ROOT, "APPEND_SYSTEM.md");
const MODELS_CONFIG_PATH = path.join(PI_AGENT_ROOT, "models.json");
const CHAT_CONFIG_PATH = path.join(PI_AGENT_ROOT, "chat", "config.json");
const AUTH_CONFIG_PATH = path.join(PI_AGENT_ROOT, "auth.json");
const CHAT_WORKER_STATUS_DIR = path.join(PI_AGENT_ROOT, "chat", "worker-status");
const SUPER_AGENT_TASKS_PATH = path.join(PI_AGENT_ROOT, "super-agent", "tasks.json");
const PISTUDIO_INSTANCES_DIR = path.join(os.homedir(), ".pi", "pistudio-instances");
const PROJECT_CONFIG_DIR_NAME = ".pi";
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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

function parseSkillScope(value: unknown): SkillScope {
  if (value === "global" || value === "project") return value;
  throw new Error("Invalid skill inventory scope");
}

function parseSkillTarget(value: unknown): SkillTarget {
  if (!value || typeof value !== "object") throw new Error("Invalid skill inventory mutation");
  const target = value as { kind?: unknown; id?: unknown };
  if (target.kind !== "skill" && target.kind !== "group") {
    throw new Error("Invalid skill inventory mutation");
  }
  if (typeof target.id !== "string" || target.id.length === 0) {
    throw new Error("Invalid skill inventory mutation");
  }
  return { kind: target.kind, id: target.id };
}

function skillInventoryOptions(scope: SkillScope, ctx: ConfigContext) {
  const cwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  return {
    scope,
    cwd,
    agentDir: PI_AGENT_ROOT,
    homeDir: HOME_DIR,
    projectTrusted: Boolean(ctx.isProjectTrusted?.()),
  };
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

function protocolFromModelApi(api: unknown): ProviderProtocol | null {
  const value = String(api || "").trim();
  if (value === "anthropic-messages") return "anthropic-messages";
  if (
    value === "openai-completions" ||
    value === "openai-responses" ||
    value === "azure-openai-responses" ||
    value === "mistral-conversations"
  ) {
    return "openai-completions";
  }
  return null;
}

function credentialKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cred = value as { type?: string; key?: unknown; access?: unknown };
  if (cred.type === "api_key" && typeof cred.key === "string" && cred.key.trim()) {
    return cred.key.trim();
  }
  if (cred.type === "oauth" && typeof cred.access === "string" && cred.access.trim()) {
    return cred.access.trim();
  }
  return undefined;
}

async function resolveProviderApiKeyForHealthCheck(
  registry: CatalogRegistry,
  provider: string,
  model: CatalogModel,
): Promise<string | undefined> {
  if (typeof registry.getApiKeyForProvider === "function") {
    try {
      const key = await registry.getApiKeyForProvider(provider);
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      // fall through
    }
  }
  if (typeof registry.getApiKeyAndHeaders === "function") {
    try {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (auth?.ok !== false && typeof auth?.apiKey === "string" && auth.apiKey.trim()) {
        return auth.apiKey.trim();
      }
    } catch {
      // fall through
    }
  }
  const internals = registry as CatalogRegistry & RegistryInternals;
  const store = internals.runtime?.credentials ?? internals.credentials;
  if (typeof store?.read === "function") {
    try {
      const key = credentialKey(await store.read(provider));
      if (key) return key;
    } catch {
      // fall through
    }
  }
  if (typeof model.apiKey === "string" && model.apiKey.trim()) return model.apiKey.trim();
  try {
    const key = credentialKey(readAuthConfig()[provider]);
    if (key) return key;
  } catch {
    // ignore
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_CONFIG_PATH, "utf8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    const key = parsed.providers?.[provider]?.apiKey;
    if (typeof key === "string" && key.trim()) return key.trim();
  } catch {
    // ignore
  }
  return undefined;
}

function asProviderProtocol(value: unknown): ProviderProtocol {
  if (value === "openai-completions" || value === "anthropic-messages") return value;
  throw new Error("protocol must be openai-completions or anthropic-messages");
}

function parseProbeModels(params: Record<string, unknown>): ProbeModel[] {
  const modelsRaw = params.models;
  if (Array.isArray(modelsRaw)) {
    return modelsRaw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id.trim() : "",
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.contextWindow === "number" ? { contextWindow: item.contextWindow } : {}),
        ...(typeof item.maxTokens === "number" ? { maxTokens: item.maxTokens } : {}),
      }))
      .filter((model) => Boolean(model.id));
  }
  const modelIds = params.modelIds;
  if (!Array.isArray(modelIds)) return [];
  return modelIds
    .map((id) => (typeof id === "string" ? id.trim() : ""))
    .filter(Boolean)
    .map((id) => ({ id }));
}

async function runHttpModelHealthCheck(
  registry: CatalogRegistry,
  model: CatalogModel,
): Promise<{ ok: boolean; latencyMs: number; error?: string } | null> {
  const protocol = protocolFromModelApi(model.api);
  const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl.trim() : "";
  const provider = typeof model.provider === "string" ? model.provider : "";
  const modelId = typeof model.id === "string" ? model.id : "";
  if (!protocol || !baseUrl || !provider || !modelId) return null;
  const apiKey = await resolveProviderApiKeyForHealthCheck(registry, provider, model);
  if (!apiKey) return null;
  const probe = await testProviderConnectivity({
    baseUrl,
    apiKey,
    protocol,
    modelId,
  });
  return {
    ok: probe.ok,
    latencyMs: probe.latencyMs,
    error: probe.ok
      ? undefined
      : probe.error || (probe.status ? `HTTP ${probe.status}` : "Health check failed"),
  };
}

async function runSessionModelHealthCheck(model: CatalogModel): Promise<{
  ok: boolean;
  error?: string;
}> {
  let sawAssistantText = false;
  const modelRuntime = await ModelRuntime.create();
  const { session } = await createAgentSession({
    model,
    tools: [],
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
  } as Parameters<typeof createAgentSession>[0]);
  try {
    const unsubscribe = session.subscribe((event: unknown) => {
      const evt = event as {
        assistantMessageEvent?: { type?: string; delta?: string };
        message?: { content?: unknown };
      };
      if (
        evt.assistantMessageEvent?.type === "text_delta" &&
        typeof evt.assistantMessageEvent.delta === "string" &&
        evt.assistantMessageEvent.delta.length > 0
      ) {
        sawAssistantText = true;
      }
      const content = evt.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string" &&
            (block as { text: string }).text.trim()
          ) {
            sawAssistantText = true;
          }
        }
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
  return {
    ok: sawAssistantText,
    error: sawAssistantText ? undefined : "No assistant text returned",
  };
}

async function runModelHealthCheck(
  registry: CatalogRegistry,
  model: CatalogModel,
  preferences: ModelPreferencesStore,
): Promise<{ provider: string; modelId: string } & ModelHealth> {
  const provider = model.provider as string;
  const modelId = model.id as string;
  const startedAt = Date.now();
  try {
    const httpProbe = await runHttpModelHealthCheck(registry, model);
    const probe = httpProbe ?? (await runSessionModelHealthCheck(model));
    const result: { provider: string; modelId: string } & ModelHealth = {
      provider,
      modelId,
      status: probe.ok ? "healthy" : "unhealthy",
      checkedAt: new Date().toISOString(),
      latencyMs: httpProbe?.latencyMs ?? Date.now() - startedAt,
      error: probe.ok ? undefined : sanitizeHealthError(probe.error || "Health check failed"),
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
  try {
    JSON.parse(content); // validate before writing
  } catch (error) {
    throw new Error(
      `content is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

// Plain-text counterpart of readConfigFile/writeConfigFile for agent-root
// markdown files (AGENTS.md / APPEND_SYSTEM.md). A missing file is not an
// error — it reads as empty content so the editor starts from a blank file.
function readTextFile(filePath: string): { content: string; path: string; exists: boolean } {
  const exists = fs.existsSync(filePath);
  const content = exists ? fs.readFileSync(filePath, "utf8") : "";
  return { content, path: filePath, exists };
}

function writeTextFile(filePath: string, content: unknown): void {
  if (typeof content !== "string") throw new Error("content must be a string");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Copy the current config file to `<path>.bak` before an overwrite, so a bad
 * save can be rolled back. No-op when the file does not exist yet.
 */
function backupConfigFile(configPath: string): void {
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, `${configPath}.bak`);
  }
}

async function refreshRegistryBestEffort(registry?: CatalogRegistry): Promise<boolean> {
  if (!registry) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), MODEL_REGISTRY_REFRESH_TIMEOUT_MS);
      timer.unref?.();
    });
    const refresh = (async () => {
      await registry.refresh();
      return true;
    })().catch(() => false);
    return await Promise.race([refresh, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readSettingsObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Pi settings at ${filePath} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Pi settings must be a JSON object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function writeSettingsObject(filePath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.picot-settings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function asThinkingLevel(value: unknown): ThinkingLevel {
  const level = asString(value);
  if (THINKING_LEVELS.has(level as ThinkingLevel)) return level as ThinkingLevel;
  throw new Error(`Unsupported thinking level: ${level || String(value)}`);
}

function resolveSettingsPath(
  scope: unknown,
  ctx: ConfigContext,
): { scope: "global" | "project"; path: string } {
  const normalizedScope = asString(scope) || "global";
  if (normalizedScope === "global") return { scope: "global", path: AGENT_CONFIG_PATH };
  if (normalizedScope !== "project")
    throw new Error(`Unsupported settings scope: ${normalizedScope}`);
  const cwd = asString(ctx.cwd);
  if (!cwd) throw new Error("Project settings require an active workspace");
  if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) {
    throw new Error("Project settings cannot be changed until the workspace is trusted");
  }
  return {
    scope: "project",
    path: path.join(cwd, PROJECT_CONFIG_DIR_NAME, "settings.json"),
  };
}

function getProjectSettings(
  ctx: ConfigContext,
): { path: string; settings: Record<string, unknown> } | null {
  const cwd = asString(ctx.cwd);
  if (!cwd || (ctx.isProjectTrusted && !ctx.isProjectTrusted())) return null;
  const settingsPath = path.join(cwd, PROJECT_CONFIG_DIR_NAME, "settings.json");
  return { path: settingsPath, settings: readSettingsObject(settingsPath) };
}

function getDefaultThinkingLevel(scope: unknown, ctx: ConfigContext) {
  const requestedScope = asString(scope) || "global";
  if (requestedScope === "project" || requestedScope === "effective") {
    const project = getProjectSettings(ctx);
    const projectValue = project?.settings.defaultThinkingLevel;
    if (typeof projectValue === "string" && THINKING_LEVELS.has(projectValue as ThinkingLevel)) {
      return { level: projectValue, source: "project", path: project.path };
    }
    if (requestedScope === "project") {
      const writableProject = resolveSettingsPath("project", ctx);
      return { level: "off", source: "pi_default", path: writableProject.path };
    }
  }
  const globalValue = readSettingsObject(AGENT_CONFIG_PATH).defaultThinkingLevel;
  if (typeof globalValue === "string" && THINKING_LEVELS.has(globalValue as ThinkingLevel)) {
    return { level: globalValue, source: "global", path: AGENT_CONFIG_PATH };
  }
  return { level: "off", source: "pi_default", path: AGENT_CONFIG_PATH };
}

function setDefaultThinkingLevel(level: unknown, scope: unknown, ctx: ConfigContext) {
  const thinkingLevel = asThinkingLevel(level);
  const target = resolveSettingsPath(scope, ctx);
  const settings = readSettingsObject(target.path);
  settings.defaultThinkingLevel = thinkingLevel;
  writeSettingsObject(target.path, settings);
  return { level: thinkingLevel, scope: target.scope, path: target.path };
}

function getCompactionEnabled(settings: Record<string, unknown>): boolean | undefined {
  const compaction = settings.compaction;
  if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return undefined;
  const enabled = (compaction as Record<string, unknown>).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

function getDefaultAutoCompaction(scope: unknown, ctx: ConfigContext) {
  const requestedScope = asString(scope) || "global";
  if (requestedScope === "project" || requestedScope === "effective") {
    const project = getProjectSettings(ctx);
    const projectValue = project ? getCompactionEnabled(project.settings) : undefined;
    if (typeof projectValue === "boolean") {
      return { enabled: projectValue, source: "project", path: project?.path };
    }
    if (requestedScope === "project") {
      const writableProject = resolveSettingsPath("project", ctx);
      return { enabled: true, source: "pi_default", path: writableProject.path };
    }
  }
  const globalValue = getCompactionEnabled(readSettingsObject(AGENT_CONFIG_PATH));
  if (typeof globalValue === "boolean") {
    return { enabled: globalValue, source: "global", path: AGENT_CONFIG_PATH };
  }
  return { enabled: true, source: "pi_default", path: AGENT_CONFIG_PATH };
}

function setDefaultAutoCompaction(enabled: unknown, scope: unknown, ctx: ConfigContext) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  const target = resolveSettingsPath(scope, ctx);
  const settings = readSettingsObject(target.path);
  const existing = settings.compaction;
  const compaction =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  compaction.enabled = enabled;
  settings.compaction = compaction;
  writeSettingsObject(target.path, settings);
  return { enabled, scope: target.scope, path: target.path };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readJsonFile(filePath: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function getChatWorkerStatuses(): TelegramWorkerStatusLike[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(CHAT_WORKER_STATUS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readJsonFile(path.join(CHAT_WORKER_STATUS_DIR, entry)))
    .filter((value): value is JsonObject & TelegramWorkerStatusLike => Boolean(value));
}

type SuperAgentProject = { name: string; cwd: string; status: string };

// The Runtime panel's project picker lists dispatch targets. In the native
// architecture the old `/api/super-agent/projects` HTTP endpoint no longer
// exists, so we reconstruct the list from the per-process instance records
// Picot writes to ~/.pi/pistudio-instances/*.json (each has a `cwd`). The
// super-agent workspace itself is never a dispatch target.
function listSuperAgentProjects(): SuperAgentProject[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(PISTUDIO_INSTANCES_DIR);
  } catch {
    return [];
  }
  const byCwd = new Map<string, SuperAgentProject>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = readJsonFile(path.join(PISTUDIO_INSTANCES_DIR, entry)) as
      | { cwd?: unknown }
      | undefined;
    const cwd = typeof record?.cwd === "string" ? record.cwd.replace(/\/+$/, "") : "";
    if (!cwd || cwd.endsWith("/.pi/agent/super-agent")) continue;
    byCwd.set(cwd, { name: cwd.split("/").pop() || cwd, cwd, status: "running" });
  }
  return [...byCwd.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function telegramBotPayload(identity: TelegramBotIdentity) {
  return {
    id: identity.id,
    name: identity.name,
    username: identity.username,
    webUrl: identity.username ? `https://web.telegram.org/k/#@${identity.username}` : undefined,
    appUrl: identity.username ? `tg://resolve?domain=${identity.username}` : undefined,
  };
}

function readAuthConfig(): Record<string, unknown> {
  if (!fs.existsSync(AUTH_CONFIG_PATH)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function writeAuthConfig(auth: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(AUTH_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(auth, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(AUTH_CONFIG_PATH, 0o600);
  } catch {
    // chmod is best-effort on platforms/filesystems that do not support POSIX modes.
  }
}

async function setStoredApiKey(
  registry: CatalogRegistry | undefined,
  provider: string,
  apiKey: string,
): Promise<void> {
  const internals = registry as (CatalogRegistry & RegistryInternals) | undefined;
  const credentials = internals?.runtime?.credentials;
  if (credentials?.modify) {
    await credentials.modify(provider, async () => ({ type: "api_key", key: apiKey }));
    return;
  }
  if (internals?.authStorage?.set) {
    await internals.authStorage.set(provider, { type: "api_key", key: apiKey });
    return;
  }
  const auth = readAuthConfig();
  auth[provider] = { type: "api_key", key: apiKey };
  writeAuthConfig(auth);
}

async function removeStoredApiKey(
  registry: CatalogRegistry | undefined,
  provider: string,
): Promise<void> {
  const internals = registry as (CatalogRegistry & RegistryInternals) | undefined;
  const credentials = internals?.runtime?.credentials;
  if (credentials?.delete) {
    await credentials.delete(provider);
    return;
  }
  if (internals?.authStorage?.remove) {
    await internals.authStorage.remove(provider);
    return;
  }
  if (!fs.existsSync(AUTH_CONFIG_PATH)) return;
  const auth = readAuthConfig();
  delete auth[provider];
  writeAuthConfig(auth);
}

// Dispatch a single Configuration operation. `ctx` is the extension command
// context; `ctx.modelRegistry` provides live provider/model/auth access.
export async function handlePicotConfig(
  op: string,
  params: Record<string, unknown>,
  ctx: ConfigContext,
): Promise<PicotConfigResult> {
  const registry = ctx.modelRegistry;
  const preferences = new ModelPreferencesStore();

  const requireRegistry = (): CatalogRegistry => {
    if (!registry) throw new Error("Model registry not ready yet — try again in a moment.");
    return registry;
  };

  try {
    switch (op) {
      case "write_paste_offload": {
        const content = params.content;
        if (typeof content !== "string") throw new Error("content is required");
        if (!ctx.cwd) throw new Error("Active workspace is required");
        const result = writePasteOffloadFile(ctx.cwd, content);
        return { ok: true, data: { path: result.relativePath } };
      }
      case "get_oauth_login_capabilities": {
        const runtime = await ModelRuntime.create();
        const adapter = createPiOAuthLoginAdapter(runtime);
        const capability = await adapter.getCodexCapability();
        if (capability.kind !== "supported") {
          // Unsupported / unavailable providers report an empty list rather
          // than a synthesized capability (baseline protocol rule).
          return { ok: true, data: { providers: [] } };
        }
        // ModelRuntime.checkAuth returns AuthCheck | undefined; an AuthCheck
        // means Pi holds a usable credential regardless of method.
        const configured = Boolean(await runtime.checkAuth("openai-codex"));
        return {
          ok: true,
          data: { providers: [{ providerId: "openai-codex", deviceCode: true, configured }] },
        };
      }

      case "start_oauth_login": {
        const provider = asString(params.provider);
        const method = asString(params.method);
        if (provider !== "openai-codex" || method !== "device_code") {
          throw new Error("Unsupported OAuth provider or method");
        }
        if (!ctx.oauthNotify) throw new Error("OAuth event channel is unavailable");
        const started = oauthLoginManager.start();
        const emit = (event: OAuthOperationEvent) => ctx.oauthNotify?.(event);
        // Fire-and-forget: the response resolves immediately with the
        // operation id; device-code/progress/terminal events stream over the
        // config notify channel afterwards.
        void (async () => {
          const runtime = await ModelRuntime.create();
          const adapter = createPiOAuthLoginAdapter(runtime);
          let expiryTimer: ReturnType<typeof setTimeout> | null = null;
          const clearExpiryTimer = () => {
            if (expiryTimer) {
              clearTimeout(expiryTimer);
              expiryTimer = null;
            }
          };
          try {
            await adapter.startCodexDeviceCodeLogin(
              {
                onDeviceCode: (code) => {
                  try {
                    emit(oauthLoginManager.bindDeviceCode(started.operationId, code));
                    if (code.expiresInSeconds && code.expiresInSeconds > 0) {
                      clearExpiryTimer();
                      expiryTimer = setTimeout(() => {
                        expiryTimer = null;
                        try {
                          emit(oauthLoginManager.expire(started.operationId));
                        } catch {
                          // Operation already terminal.
                        }
                      }, code.expiresInSeconds * 1000);
                    }
                  } catch {
                    // Operation already terminal; nothing to emit.
                  }
                },
                onProgress: (message) => {
                  try {
                    emit(oauthLoginManager.bindProgress(started.operationId, message));
                  } catch {
                    // Operation already terminal; nothing to emit.
                  }
                },
              },
              started.signal,
            );
            clearExpiryTimer();
            try {
              emit(oauthLoginManager.complete(started.operationId));
              if (registry) await registry.refresh();
            } catch {
              // Already removed (cancelled/expired) — nothing to complete.
            }
          } catch (error) {
            clearExpiryTimer();
            const aborted = (error as Error | null)?.name === "AbortError";
            try {
              const event = aborted
                ? oauthLoginManager.cancel(started.operationId)
                : oauthLoginManager.fail(started.operationId, error);
              if (event) emit(event);
            } catch {
              // Already terminal; nothing to emit.
            }
          }
        })().catch((error) => {
          console.warn("[picot-config] OAuth login chain error:", error);
        });
        return {
          ok: true,
          data: { operationId: started.operationId, provider: "openai-codex", state: "starting" },
        };
      }

      case "cancel_oauth_login": {
        const operationId = asString(params.operationId);
        if (!operationId) throw new Error("operationId is required");
        // Unknown ids are a tolerated no-op (map wiped by restart/reload);
        // the UI treats them as expired per design §5.
        const cancelled = oauthLoginManager.cancel(operationId);
        if (cancelled) ctx.oauthNotify?.(cancelled);
        return { ok: true, data: { operationId } };
      }

      case "get_oauth_login_status": {
        const operationId = asString(params.operationId);
        if (!operationId) throw new Error("operationId is required");
        return { ok: true, data: oauthLoginManager.getStatus(operationId) };
      }

      case "oauth_logout": {
        const provider = asString(params.provider);
        // Same codex-only whitelist as start_oauth_login (design §3): the
        // op surface never forwards another provider to runtime.logout().
        if (provider !== "openai-codex") throw new Error("Unsupported OAuth provider");
        const runtime = await ModelRuntime.create();
        await runtime.logout(provider);
        if (registry) await registry.refresh();
        return { ok: true, data: { provider } };
      }

      case "navigate_tree": {
        const targetId = asString(params.targetId);
        if (!targetId) throw new Error("targetId is required");
        if (typeof ctx.navigateTree !== "function") {
          throw new Error("Session tree navigation is unavailable.");
        }
        const result = await ctx.navigateTree(targetId, {
          summarize: params.summarize === true,
          ...(typeof params.customInstructions === "string"
            ? { customInstructions: params.customInstructions }
            : {}),
          ...(typeof params.replaceInstructions === "boolean"
            ? { replaceInstructions: params.replaceInstructions }
            : {}),
          ...(typeof params.label === "string" ? { label: params.label } : {}),
        });
        return { ok: true, data: result ?? { cancelled: false } };
      }
      case "rename_historical_session": {
        const result = await renameHistoricalSession(params.filePath, params.name);
        return { ok: true, data: result };
      }
      case "generate_session_title": {
        const sessionFile = ctx.sessionManager?.getSessionFile();
        if (!sessionFile) throw new Error("The active session has not been saved yet.");
        const modelRuntime = await ModelRuntime.create();
        const title = await generateTitleForSession(sessionFile, {
          model: ctx.model,
          modelRuntime,
        });
        return { ok: true, data: { title } };
      }
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
          return availableKeys.has(modelPreferenceKey(provider, model.id as string));
        });
        if (models.length === 0) throw new Error("No matching models available for health check");
        const results = [];
        for (const model of models) {
          results.push(await runModelHealthCheck(reg, model, preferences));
        }
        return { ok: true, data: { results } };
      }

      case "set_api_key": {
        const provider = asString(params.provider);
        const apiKey = asString(params.apiKey);
        if (!provider) throw new Error("provider is required");
        if (!apiKey) throw new Error("apiKey is required");
        await setStoredApiKey(registry, provider, apiKey);
        if (registry) await registry.refresh();
        return { ok: true, data: { provider } };
      }

      case "remove_api_key": {
        const provider = asString(params.provider);
        if (!provider) throw new Error("provider is required");
        await removeStoredApiKey(registry, provider);
        if (registry) await registry.refresh();
        return { ok: true, data: { provider } };
      }

      case "list_package_skill_inventory": {
        const scope = parseSkillScope(params.scope);
        return {
          ok: true,
          data: buildPackageSkillInventory(skillInventoryOptions(scope, ctx)),
        };
      }

      case "list_skill_inventory": {
        const scope = parseSkillScope(params.scope);
        return { ok: true, data: buildSkillInventory(skillInventoryOptions(scope, ctx)) };
      }

      case "set_skill_enabled": {
        const mutation = params as SkillInventoryMutation;
        const scope = parseSkillScope(mutation.scope);
        const target = parseSkillTarget(mutation.target);
        if (typeof mutation.enabled !== "boolean") {
          throw new Error("Invalid skill inventory mutation");
        }
        const result = await mutateSkillEnabled({
          ...skillInventoryOptions(scope, ctx),
          target,
          enabled: mutation.enabled,
        });
        return { ok: true, data: result };
      }

      case "read_agent_config":
        return { ok: true, data: readConfigFile(AGENT_CONFIG_PATH, "{}") };

      case "write_agent_config": {
        writeConfigFile(AGENT_CONFIG_PATH, params.content);
        return { ok: true, data: { path: AGENT_CONFIG_PATH } };
      }

      // Global agent context / system-prompt append file read/write. AGENTS.md
      // is injected as global context instructions and APPEND_SYSTEM.md is
      // appended to the system prompt without replacing it (pi docs "System
      // Prompt Files"); project-level .pi/ files are workspace files and are
      // edited through the workspace file browser instead. Markdown is plain
      // text, so no JSON validation applies.
      case "read_agents_md":
        return { ok: true, data: readTextFile(AGENTS_MD_PATH) };

      case "write_agents_md": {
        writeTextFile(AGENTS_MD_PATH, params.content);
        return { ok: true, data: { path: AGENTS_MD_PATH } };
      }

      case "read_append_system_md":
        return { ok: true, data: readTextFile(APPEND_SYSTEM_MD_PATH) };

      case "write_append_system_md": {
        writeTextFile(APPEND_SYSTEM_MD_PATH, params.content);
        return { ok: true, data: { path: APPEND_SYSTEM_MD_PATH } };
      }

      case "get_default_thinking_level":
        return { ok: true, data: getDefaultThinkingLevel(params.scope, ctx) };

      case "set_default_thinking_level":
        return { ok: true, data: setDefaultThinkingLevel(params.level, params.scope, ctx) };

      case "get_default_auto_compaction":
        return { ok: true, data: getDefaultAutoCompaction(params.scope, ctx) };

      case "set_default_auto_compaction":
        return { ok: true, data: setDefaultAutoCompaction(params.enabled, params.scope, ctx) };

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
        // Keep a safety copy of the previous models.json so a bad save can be
        // rolled back; the frontend can restore it if the new content breaks.
        backupConfigFile(MODELS_CONFIG_PATH);
        writeConfigFile(MODELS_CONFIG_PATH, content);
        const refreshed = await refreshRegistryBestEffort(registry);
        return { ok: true, data: { path: MODELS_CONFIG_PATH, refreshed } };
      }

      case "detect_custom_provider": {
        const preferredRaw = asString(params.preferred) || "auto";
        const preferred =
          preferredRaw === "openai-completions" || preferredRaw === "anthropic-messages"
            ? preferredRaw
            : "auto";
        const result = await detectProviderProtocol({
          baseUrl: asString(params.baseUrl),
          apiKey: asString(params.apiKey),
          preferred,
        });
        return { ok: true, data: result };
      }

      case "list_custom_provider_models": {
        const listed = await fetchUpstreamModels({
          baseUrl: asString(params.baseUrl),
          apiKey: asString(params.apiKey),
          protocol: asProviderProtocol(params.protocol),
        });
        return { ok: true, data: listed };
      }

      case "test_custom_provider": {
        const result = await testProviderConnectivity({
          baseUrl: asString(params.baseUrl),
          apiKey: asString(params.apiKey),
          protocol: asProviderProtocol(params.protocol),
          modelId: asString(params.modelId) || undefined,
        });
        return { ok: true, data: result };
      }

      case "save_custom_provider": {
        const protocol = asProviderProtocol(params.protocol);
        const baseUrl = normalizeBaseUrl(asString(params.baseUrl));
        const providerId = resolveProviderId(asString(params.providerId), baseUrl);
        const models = parseProbeModels(params);
        if (models.length === 0) throw new Error("Select at least one model");
        const apiKey = asString(params.apiKey);
        const storeKey = params.storeKey !== false;
        const includeApiKeyInFile = params.includeApiKeyInFile === true;
        if (storeKey && !apiKey) throw new Error("apiKey is required when storeKey is true");
        const entry = buildModelsJsonProviderEntry({
          baseUrl,
          protocol,
          models,
          apiKey,
          includeApiKeyInFile,
        });
        let existing: unknown = { providers: {} };
        if (fs.existsSync(MODELS_CONFIG_PATH)) {
          try {
            existing = JSON.parse(fs.readFileSync(MODELS_CONFIG_PATH, "utf8"));
          } catch {
            existing = { providers: {} };
          }
        }
        const merged = mergeProviderIntoModelsJson(
          existing as ModelsJsonDocument,
          providerId,
          entry,
        );
        writeConfigFile(MODELS_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
        let keyStored = false;
        if (storeKey && apiKey) {
          await setStoredApiKey(registry, providerId, apiKey);
          keyStored = true;
        }
        const refreshed = await refreshRegistryBestEffort(registry);
        return {
          ok: true,
          data: {
            providerId,
            baseUrl,
            protocol,
            modelCount: models.length,
            keyStored,
            refreshed,
            path: MODELS_CONFIG_PATH,
          },
        };
      }

      case "read_chat_config":
        return { ok: true, data: readConfigFile(CHAT_CONFIG_PATH, "{}") };

      case "write_chat_config": {
        writeConfigFile(CHAT_CONFIG_PATH, params.content);
        return { ok: true, data: { path: CHAT_CONFIG_PATH } };
      }

      case "telegram_validate": {
        const botToken = asString(params.botToken);
        if (!botToken) throw new Error("botToken required");
        const identity = await getTelegramBotIdentity(botToken);
        const afterUpdateId = await getLatestTelegramUpdateId(botToken);
        return {
          ok: true,
          data: {
            bot: telegramBotPayload(identity),
            afterUpdateId,
          },
        };
      }

      case "telegram_bind": {
        const botToken = asString(params.botToken);
        if (!botToken) throw new Error("botToken required");
        const identity = await getTelegramBotIdentity(botToken);
        const dm = await observeTelegramPrivateDm(botToken, identity.id, {
          afterUpdateId: asNumber(params.afterUpdateId),
          timeoutMs: 90_000,
        });
        if (!dm) {
          throw new Error(
            "Timed out waiting for a private Telegram message. Send /start to the bot and try again.",
          );
        }

        const existingConfig = fs.existsSync(CHAT_CONFIG_PATH)
          ? (JSON.parse(fs.readFileSync(CHAT_CONFIG_PATH, "utf8")) as Record<string, unknown>)
          : {};
        const nextConfig = buildTelegramDmConfig(existingConfig, {
          botToken,
          identity,
          dm,
        });
        const content = `${JSON.stringify(nextConfig, null, "\t")}\n`;
        writeConfigFile(CHAT_CONFIG_PATH, content);
        return {
          ok: true,
          data: {
            content,
            bot: telegramBotPayload(identity),
            dm,
            path: CHAT_CONFIG_PATH,
          },
        };
      }

      case "telegram_doctor": {
        const config = fs.existsSync(CHAT_CONFIG_PATH)
          ? (JSON.parse(fs.readFileSync(CHAT_CONFIG_PATH, "utf8")) as Record<string, unknown>)
          : {};
        const telegramAccount = Object.values(
          (config as { accounts?: Record<string, unknown> }).accounts || {},
        ).find(
          (account) =>
            typeof account === "object" &&
            account !== null &&
            (account as { service?: unknown }).service === "telegram",
        ) as { botToken?: string } | undefined;
        let bot: TelegramBotIdentity | undefined;
        let botError: string | undefined;
        if (telegramAccount?.botToken) {
          try {
            bot = await getTelegramBotIdentity(telegramAccount.botToken);
          } catch (e: unknown) {
            botError = errMessage(e);
          }
        }
        return {
          ok: true,
          data: {
            report: buildTelegramDoctorReport(config, {
              bot,
              botError,
              workerStatuses: getChatWorkerStatuses(),
            }),
          },
        };
      }

      case "read_super_agent_tasks": {
        let content: string;
        if (fs.existsSync(SUPER_AGENT_TASKS_PATH)) {
          content = fs.readFileSync(SUPER_AGENT_TASKS_PATH, "utf8");
        } else {
          fs.mkdirSync(path.dirname(SUPER_AGENT_TASKS_PATH), { recursive: true });
          content = '{"tasks":[]}';
          fs.writeFileSync(SUPER_AGENT_TASKS_PATH, content, "utf8");
        }
        let tasks: unknown[] = [];
        try {
          const parsed = JSON.parse(content) as { tasks?: unknown[] };
          tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        } catch {
          tasks = [];
        }
        return { ok: true, data: { tasks } };
      }

      case "write_super_agent_tasks": {
        const tasks = Array.isArray(params.tasks) ? params.tasks : [];
        fs.mkdirSync(path.dirname(SUPER_AGENT_TASKS_PATH), { recursive: true });
        fs.writeFileSync(SUPER_AGENT_TASKS_PATH, JSON.stringify({ tasks }, null, 2), "utf8");
        return { ok: true, data: { count: tasks.length } };
      }

      case "list_super_agent_projects": {
        return { ok: true, data: { projects: listSuperAgentProjects() } };
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
    // windowsHide: a console-less pi process would otherwise flash a cmd window.
    execFile(command, args, { windowsHide: true }, () => {});
  } catch {
    // Best-effort; frontend falls back to window.open.
  }
}
