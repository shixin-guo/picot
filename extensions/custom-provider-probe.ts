/**
 * Custom / relay model-provider probe helpers.
 *
 * Used by Settings → Configuration → Authentication to:
 * - auto-detect OpenAI-compatible vs Claude/Anthropic protocols
 * - list upstream models
 * - measure connectivity latency
 * - merge a provider entry into ~/.pi/agent/models.json
 *
 * Pure-ish network helpers — inject `fetchImpl` in tests.
 */

export type ProviderProtocol = "openai-completions" | "anthropic-messages";

export type ProbeModel = {
  id: string;
  name?: string;
  ownedBy?: string;
};

export type ProtocolProbeAttempt = {
  protocol: ProviderProtocol;
  ok: boolean;
  status?: number;
  latencyMs: number;
  endpoint: string;
  error?: string;
  models?: ProbeModel[];
};

export type ProtocolProbeResult = {
  baseUrl: string;
  protocol: ProviderProtocol | "unknown";
  confidence: "high" | "medium" | "low" | "none";
  latencyMs?: number;
  models: ProbeModel[];
  attempts: ProtocolProbeAttempt[];
  error?: string;
};

export type ConnectivityProbeResult = {
  ok: boolean;
  protocol: ProviderProtocol;
  latencyMs: number;
  endpoint: string;
  status?: number;
  error?: string;
};

export type ModelsJsonProvider = {
  baseUrl: string;
  api: ProviderProtocol;
  apiKey?: string;
  models: Array<{ id: string; name?: string }>;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ModelsJsonDocument = {
  providers?: Record<string, ModelsJsonProvider>;
  [key: string]: unknown;
};

type FetchLike = typeof fetch;

const OPENAI_COMPAT_HINTS = [
  "openai",
  "gpt-",
  "o1",
  "o3",
  "deepseek",
  "qwen",
  "glm",
  "moonshot",
  "doubao",
  "yi-",
  "llama",
  "mistral",
  "gemini",
];

const CLAUDE_HINTS = ["claude", "anthropic", "haiku", "sonnet", "opus"];

export function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("baseUrl is required");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("baseUrl must be a valid absolute URL (http/https)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  // Drop trailing slash; keep path prefix used by many Chinese relay stations.
  url.hash = "";
  url.search = "";
  let href = url.toString();
  if (href.endsWith("/")) href = href.slice(0, -1);
  return href;
}

export function sanitizeProviderId(raw: string): string {
  const id = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("provider id is required");
  if (id.length > 64) throw new Error("provider id is too long (max 64)");
  return id;
}

function joinUrl(baseUrl: string, pathPart: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const part = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  // Avoid double /v1/v1 when user already ends with /v1
  if (base.endsWith("/v1") && part.startsWith("/v1/")) {
    return `${base}${part.slice(3)}`;
  }
  return `${base}${part}`;
}

function openaiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function anthropicAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

function parseOpenAiModels(payload: unknown): ProbeModel[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: ProbeModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) continue;
    const name =
      typeof (item as { name?: unknown }).name === "string"
        ? ((item as { name: string }).name as string)
        : undefined;
    const ownedBy =
      typeof (item as { owned_by?: unknown }).owned_by === "string"
        ? ((item as { owned_by: string }).owned_by as string)
        : undefined;
    models.push({ id: id.trim(), name, ownedBy });
  }
  return models;
}

function parseAnthropicModels(payload: unknown): ProbeModel[] {
  // Anthropic official: { data: [{ id, display_name, ... }] }
  const fromData = parseOpenAiModels(payload);
  if (fromData.length > 0) return fromData;
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: ProbeModel[] = [];
  for (const item of models) {
    if (typeof item === "string" && item.trim()) {
      out.push({ id: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const id =
      typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id
        : typeof (item as { name?: unknown }).name === "string"
          ? (item as { name: string }).name
          : "";
    if (!id.trim()) continue;
    const name =
      typeof (item as { display_name?: unknown }).display_name === "string"
        ? (item as { display_name: string }).display_name
        : typeof (item as { name?: unknown }).name === "string"
          ? (item as { name: string }).name
          : undefined;
    out.push({ id: id.trim(), name });
  }
  return out;
}

function scoreProtocolFromModels(
  models: ProbeModel[],
  preferred: ProviderProtocol,
): number {
  if (models.length === 0) return preferred === "openai-completions" ? 1 : 0;
  let openaiHits = 0;
  let claudeHits = 0;
  for (const model of models) {
    const hay = `${model.id} ${model.name || ""} ${model.ownedBy || ""}`.toLowerCase();
    if (CLAUDE_HINTS.some((h) => hay.includes(h))) claudeHits += 1;
    if (OPENAI_COMPAT_HINTS.some((h) => hay.includes(h))) openaiHits += 1;
  }
  if (preferred === "anthropic-messages") {
    return claudeHits * 3 + (models.length > 0 ? 1 : 0) - openaiHits;
  }
  return openaiHits * 2 + (models.length > 0 ? 2 : 0) - claudeHits;
}

async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = 15000,
): Promise<{ response?: Response; latencyMs: number; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { response, latencyMs: Date.now() - started };
  } catch (e: unknown) {
    const message =
      e instanceof Error
        ? e.name === "AbortError"
          ? `Request timed out after ${timeoutMs}ms`
          : e.message
        : String(e);
    return { latencyMs: Date.now() - started, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function probeOpenAi(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<ProtocolProbeAttempt> {
  const endpoint = joinUrl(baseUrl, "/v1/models");
  const { response, latencyMs, error } = await timedFetch(fetchImpl, endpoint, {
    method: "GET",
    headers: openaiAuthHeaders(apiKey),
  });
  if (error || !response) {
    return {
      protocol: "openai-completions",
      ok: false,
      latencyMs,
      endpoint,
      error: error || "No response",
    };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      protocol: "openai-completions",
      ok: false,
      status: response.status,
      latencyMs,
      endpoint,
      error: body.slice(0, 240) || `HTTP ${response.status}`,
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      protocol: "openai-completions",
      ok: false,
      status: response.status,
      latencyMs,
      endpoint,
      error: "Response is not JSON",
    };
  }
  const models = parseOpenAiModels(payload);
  // Some relays return 200 with non-list bodies for wrong protocol.
  if (models.length === 0 && !(payload as { object?: string })?.object) {
    return {
      protocol: "openai-completions",
      ok: false,
      status: response.status,
      latencyMs,
      endpoint,
      error: "No OpenAI-style model list in response",
      models: [],
    };
  }
  return {
    protocol: "openai-completions",
    ok: true,
    status: response.status,
    latencyMs,
    endpoint,
    models,
  };
}

async function probeAnthropic(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<ProtocolProbeAttempt> {
  // Prefer /v1/models (official + many relays). Fall back to a tiny messages
  // probe when the models endpoint is missing.
  const modelsEndpoint = joinUrl(baseUrl, "/v1/models");
  const modelsAttempt = await timedFetch(fetchImpl, modelsEndpoint, {
    method: "GET",
    headers: anthropicAuthHeaders(apiKey),
  });

  if (modelsAttempt.response?.ok) {
    try {
      const payload = await modelsAttempt.response.json();
      const models = parseAnthropicModels(payload);
      if (models.length > 0) {
        return {
          protocol: "anthropic-messages",
          ok: true,
          status: modelsAttempt.response.status,
          latencyMs: modelsAttempt.latencyMs,
          endpoint: modelsEndpoint,
          models,
        };
      }
    } catch {
      // fall through to messages probe
    }
  }

  const messagesEndpoint = joinUrl(baseUrl, "/v1/messages");
  const messagesAttempt = await timedFetch(fetchImpl, messagesEndpoint, {
    method: "POST",
    headers: anthropicAuthHeaders(apiKey),
    body: JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  });

  if (messagesAttempt.error || !messagesAttempt.response) {
    const status = modelsAttempt.response?.status;
    const err =
      messagesAttempt.error ||
      (modelsAttempt.response
        ? `Models HTTP ${modelsAttempt.response.status}; messages failed`
        : modelsAttempt.error) ||
      "No response";
    return {
      protocol: "anthropic-messages",
      ok: false,
      status,
      latencyMs: messagesAttempt.latencyMs || modelsAttempt.latencyMs,
      endpoint: messagesEndpoint,
      error: err,
    };
  }

  // Auth/protocol success signals: 200, or 400/404 with anthropic-shaped error
  // (wrong model id still proves Claude protocol).
  const status = messagesAttempt.response.status;
  let bodyText = "";
  try {
    bodyText = await messagesAttempt.response.text();
  } catch {
    bodyText = "";
  }
  let payload: unknown;
  try {
    payload = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    payload = undefined;
  }
  const looksAnthropic =
    status === 200 ||
    (typeof bodyText === "string" &&
      (bodyText.includes("type") || bodyText.includes("anthropic") || bodyText.includes("claude"))) ||
    (payload &&
      typeof payload === "object" &&
      ("type" in (payload as object) || "error" in (payload as object)));

  if (!looksAnthropic && status >= 500) {
    return {
      protocol: "anthropic-messages",
      ok: false,
      status,
      latencyMs: messagesAttempt.latencyMs,
      endpoint: messagesEndpoint,
      error: bodyText.slice(0, 240) || `HTTP ${status}`,
    };
  }

  if (!looksAnthropic && (status === 401 || status === 403)) {
    return {
      protocol: "anthropic-messages",
      ok: false,
      status,
      latencyMs: messagesAttempt.latencyMs,
      endpoint: messagesEndpoint,
      error: bodyText.slice(0, 240) || `HTTP ${status}`,
    };
  }

  // 401 on anthropic headers against OpenAI endpoints is common; only accept
  // if models probe already hinted anthropic OR body looks anthropic.
  if (!looksAnthropic) {
    return {
      protocol: "anthropic-messages",
      ok: false,
      status,
      latencyMs: messagesAttempt.latencyMs,
      endpoint: messagesEndpoint,
      error: bodyText.slice(0, 240) || `HTTP ${status}`,
    };
  }

  return {
    protocol: "anthropic-messages",
    ok: status < 500,
    status,
    latencyMs: messagesAttempt.latencyMs,
    endpoint: messagesEndpoint,
    models: [],
    error: status >= 400 ? bodyText.slice(0, 240) || `HTTP ${status}` : undefined,
  };
}

export async function detectProviderProtocol(options: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  preferred?: ProviderProtocol | "auto";
}): Promise<ProtocolProbeResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) {
    return {
      baseUrl,
      protocol: "unknown",
      confidence: "none",
      models: [],
      attempts: [],
      error: "apiKey is required",
    };
  }
  const fetchImpl = options.fetchImpl || fetch;
  const preferred = options.preferred || "auto";

  const order: ProviderProtocol[] =
    preferred === "anthropic-messages"
      ? ["anthropic-messages", "openai-completions"]
      : preferred === "openai-completions"
        ? ["openai-completions", "anthropic-messages"]
        : ["openai-completions", "anthropic-messages"];

  const attempts: ProtocolProbeAttempt[] = [];
  for (const protocol of order) {
    const attempt =
      protocol === "openai-completions"
        ? await probeOpenAi(baseUrl, apiKey, fetchImpl)
        : await probeAnthropic(baseUrl, apiKey, fetchImpl);
    attempts.push(attempt);
  }

  const scored = attempts
    .map((attempt) => ({
      attempt,
      score:
        (attempt.ok ? 10 : 0) +
        scoreProtocolFromModels(attempt.models || [], attempt.protocol) +
        (attempt.models && attempt.models.length > 0 ? 5 : 0) -
        // Prefer faster ok attempt slightly
        (attempt.ok ? Math.min(attempt.latencyMs, 5000) / 5000 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 5) {
    return {
      baseUrl,
      protocol: "unknown",
      confidence: "none",
      models: [],
      attempts,
      error:
        attempts
          .map((a) => a.error)
          .filter(Boolean)
          .join(" | ") || "Could not detect OpenAI or Claude protocol",
    };
  }

  const models = best.attempt.models || [];
  const confidence: ProtocolProbeResult["confidence"] =
    best.score >= 16 ? "high" : best.score >= 10 ? "medium" : "low";

  return {
    baseUrl,
    protocol: best.attempt.protocol,
    confidence,
    latencyMs: best.attempt.latencyMs,
    models,
    attempts,
  };
}

export async function fetchUpstreamModels(options: {
  baseUrl: string;
  apiKey: string;
  protocol: ProviderProtocol;
  fetchImpl?: FetchLike;
}): Promise<{ models: ProbeModel[]; latencyMs: number; endpoint: string }> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) throw new Error("apiKey is required");
  const fetchImpl = options.fetchImpl || fetch;
  const attempt =
    options.protocol === "anthropic-messages"
      ? await probeAnthropic(baseUrl, apiKey, fetchImpl)
      : await probeOpenAi(baseUrl, apiKey, fetchImpl);
  if (!attempt.ok && (!attempt.models || attempt.models.length === 0)) {
    throw new Error(attempt.error || `Failed to list models (${attempt.protocol})`);
  }
  return {
    models: attempt.models || [],
    latencyMs: attempt.latencyMs,
    endpoint: attempt.endpoint,
  };
}

export async function testProviderConnectivity(options: {
  baseUrl: string;
  apiKey: string;
  protocol: ProviderProtocol;
  modelId?: string;
  fetchImpl?: FetchLike;
}): Promise<ConnectivityProbeResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) {
    return {
      ok: false,
      protocol: options.protocol,
      latencyMs: 0,
      endpoint: baseUrl,
      error: "apiKey is required",
    };
  }
  const fetchImpl = options.fetchImpl || fetch;

  if (options.protocol === "openai-completions") {
    const model = options.modelId || "gpt-4o-mini";
    const endpoint = joinUrl(baseUrl, "/v1/chat/completions");
    const { response, latencyMs, error } = await timedFetch(fetchImpl, endpoint, {
      method: "POST",
      headers: openaiAuthHeaders(apiKey),
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (error || !response) {
      return {
        ok: false,
        protocol: options.protocol,
        latencyMs,
        endpoint,
        error: error || "No response",
      };
    }
    // 200 = full success; 400 often means auth+route ok but model id wrong.
    const ok = response.status < 500 && response.status !== 401 && response.status !== 403;
    let errText: string | undefined;
    if (!ok || response.status >= 400) {
      errText = (await response.text().catch(() => "")).slice(0, 240) || `HTTP ${response.status}`;
    }
    return {
      ok,
      protocol: options.protocol,
      latencyMs,
      endpoint,
      status: response.status,
      error: ok ? undefined : errText,
    };
  }

  const model = options.modelId || "claude-3-5-haiku-latest";
  const endpoint = joinUrl(baseUrl, "/v1/messages");
  const { response, latencyMs, error } = await timedFetch(fetchImpl, endpoint, {
    method: "POST",
    headers: anthropicAuthHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  if (error || !response) {
    return {
      ok: false,
      protocol: options.protocol,
      latencyMs,
      endpoint,
      error: error || "No response",
    };
  }
  const ok = response.status < 500 && response.status !== 401 && response.status !== 403;
  let errText: string | undefined;
  if (!ok || response.status >= 400) {
    errText = (await response.text().catch(() => "")).slice(0, 240) || `HTTP ${response.status}`;
  }
  return {
    ok,
    protocol: options.protocol,
    latencyMs,
    endpoint,
    status: response.status,
    error: ok ? undefined : errText,
  };
}

export function buildModelsJsonProviderEntry(options: {
  baseUrl: string;
  protocol: ProviderProtocol;
  models: Array<string | ProbeModel>;
  apiKey?: string;
  includeApiKeyInFile?: boolean;
}): ModelsJsonProvider {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const models = options.models
    .map((m) => {
      if (typeof m === "string") return { id: m.trim() };
      return {
        id: String(m.id || "").trim(),
        ...(m.name ? { name: m.name } : {}),
      };
    })
    .filter((m) => m.id);
  if (models.length === 0) {
    throw new Error("At least one model id is required");
  }
  const entry: ModelsJsonProvider = {
    baseUrl,
    api: options.protocol,
    models,
  };
  if (options.protocol === "openai-completions") {
    entry.compat = {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    };
  }
  if (options.includeApiKeyInFile && options.apiKey) {
    entry.apiKey = options.apiKey;
  }
  return entry;
}

export function mergeProviderIntoModelsJson(
  existing: unknown,
  providerId: string,
  entry: ModelsJsonProvider,
): ModelsJsonDocument {
  const id = sanitizeProviderId(providerId);
  const doc: ModelsJsonDocument =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as ModelsJsonDocument) }
      : { providers: {} };
  const providers =
    doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers)
      ? { ...doc.providers }
      : {};
  providers[id] = entry;
  doc.providers = providers;
  return doc;
}
