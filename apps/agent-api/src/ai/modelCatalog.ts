const FALLBACK_MODEL = "anthropic/claude-opus-4-6";
const CHECK_PROMPT = "health-check";
const CHECK_TIMEOUT_MS = 4500;
const CACHE_TTL_MS = 30000;
const MAX_CATALOG_MODELS = 40;
const MAX_GATEWAY_ERROR_MESSAGE_LENGTH = 220;
const DIAGNOSTIC_TAG = "aig-probe-v3";

const CURATED_MODEL_TARGETS = [
  {
    key: "gpt-5.3-codex",
    canonicalModel: "openai/gpt-5.3-codex",
    canonicalLabel: "openai/gpt-5.3-codex",
    match: /gpt-5\.3-codex/i,
  },
  {
    key: "claude-opus-4-6",
    canonicalModel: "anthropic/claude-opus-4-6",
    canonicalLabel: "anthropic/claude-opus-4-6",
    match: /claude-opus-4-6/i,
  },
  {
    key: "gemini-3-pro",
    canonicalModel: "google-ai-studio/gemini-3-pro",
    canonicalLabel: "google-ai-studio/gemini-3-pro",
    match: /gemini-3-pro/i,
  },
] as const;

type AiModelStatus = "ready" | "missing_key" | "gateway_auth" | "invalid_model" | "error";

export interface AiModelOption {
  id: string;
  label: string;
  model: string;
  provider: string;
  byokAlias?: string;
  isDefault: boolean;
  configured: boolean;
  status: AiModelStatus;
  message?: string;
}

export interface AiModelCatalogResponse {
  ok: true;
  source: "env" | "gateway" | "default";
  checkedAt: string;
  models: AiModelOption[];
}

interface ParsedCatalogEntry {
  id: string;
  label: string;
  model: string;
  provider: string;
  byokAlias?: string;
  isDefault: boolean;
}

interface ParsedCatalogResult {
  source: "env" | "gateway" | "default";
  entries: ParsedCatalogEntry[];
}

type CatalogCacheEntry = {
  key: string;
  expiresAt: number;
  data: AiModelCatalogResponse;
};

let cache: CatalogCacheEntry | null = null;

function getGatewayConfig(env: Env): { accountId: string | null; gatewayId: string | null } {
  const accountId = env.CF_AI_GATEWAY_ACCOUNT_ID?.trim() || null;
  const gatewayId = env.CF_AI_GATEWAY_ID?.trim() || null;
  return { accountId, gatewayId };
}

function providerFromModel(model: string): string {
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) return "unknown";
  return model.slice(0, slashIndex);
}

function normalizeId(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseCatalogFromEnv(
  raw: string | undefined,
  defaultModel: string,
): ParsedCatalogResult | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;

    const entries: ParsedCatalogEntry[] = [];
    const usedIds = new Set<string>();

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const enabled = entry.enabled;
      if (enabled === false) continue;

      const model = typeof entry.model === "string" ? entry.model.trim() : "";
      if (!model) continue;

      const idCandidate =
        typeof entry.id === "string" && entry.id.trim().length > 0
          ? entry.id
          : model;
      const id = normalizeId(idCandidate);
      if (!id || usedIds.has(id)) continue;
      usedIds.add(id);

      const label =
        typeof entry.label === "string" && entry.label.trim().length > 0
          ? entry.label.trim()
          : model;
      const byokAlias =
        typeof entry.byokAlias === "string" && entry.byokAlias.trim().length > 0
          ? entry.byokAlias.trim()
          : undefined;
      entries.push({
        id,
        label,
        model,
        provider: providerFromModel(model),
        byokAlias,
        isDefault: model === defaultModel,
      });
    }

    if (entries.length === 0) return null;
    if (!entries.some((entry) => entry.isDefault)) {
      entries[0]!.isDefault = true;
    }
    return {
      source: "env",
      entries: entries.slice(0, MAX_CATALOG_MODELS),
    };
  } catch {
    return null;
  }
}

function curateCatalogEntries(
  entries: ParsedCatalogEntry[],
  defaultModel: string,
): ParsedCatalogEntry[] {
  const curated: ParsedCatalogEntry[] = [];
  for (const target of CURATED_MODEL_TARGETS) {
    const match = entries.find((entry) => target.match.test(entry.model));
    if (match) {
      curated.push({
        ...match,
        id: normalizeId(target.key),
      });
      continue;
    }
    curated.push({
      id: normalizeId(target.key),
      label: target.canonicalLabel,
      model: target.canonicalModel,
      provider: providerFromModel(target.canonicalModel),
      isDefault: false,
    });
  }

  if (curated.length === 0) return curated;
  const defaultIndex = curated.findIndex((entry) => entry.model === defaultModel);
  if (defaultIndex >= 0) {
    curated.forEach((entry, index) => {
      entry.isDefault = index === defaultIndex;
    });
  } else {
    curated.forEach((entry) => {
      entry.isDefault = entry.model === FALLBACK_MODEL;
    });
    if (!curated.some((entry) => entry.isDefault)) {
      curated[0]!.isDefault = true;
    }
  }
  return curated;
}

async function discoverCatalogFromGateway(
  env: Env,
  defaultModel: string,
): Promise<ParsedCatalogResult | null> {
  const { accountId, gatewayId } = getGatewayConfig(env);
  if (!accountId || !gatewayId) return null;

  const base = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`;
  const paths = ["/compat/models", "/models"];
  const headers = new Headers();
  const token = env.CF_AIG_AUTH_TOKEN?.trim();
  if (token) {
    headers.set("cf-aig-authorization", `Bearer ${token}`);
  }

  for (const path of paths) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: "GET",
        headers,
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as {
        data?: Array<{ id?: string }>;
        models?: Array<{ id?: string }>;
      };
      const items = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.models)
          ? payload.models
          : [];
      const entries: ParsedCatalogEntry[] = [];
      const usedIds = new Set<string>();
      for (const item of items) {
        const model = typeof item?.id === "string" ? item.id.trim() : "";
        if (!model) continue;
        const id = normalizeId(model);
        if (!id || usedIds.has(id)) continue;
        usedIds.add(id);
        entries.push({
          id,
          label: model,
          model,
          provider: providerFromModel(model),
          isDefault: model === defaultModel,
        });
      }
      if (entries.length > 0) {
        if (!entries.some((entry) => entry.isDefault)) {
          const explicitDefault = entries.find((entry) => entry.model === defaultModel);
          if (explicitDefault) {
            explicitDefault.isDefault = true;
          } else {
            entries[0]!.isDefault = true;
          }
        }
        return {
          source: "gateway",
          entries: entries.slice(0, MAX_CATALOG_MODELS),
        };
      }
    } catch {
      // Ignore discovery failures, fallback to default list.
    }
  }
  return null;
}

function classifyProbeError(
  responseStatus: number,
  bodyText: string,
): { status: AiModelStatus; message: string } {
  const detail = extractGatewayErrorDetail(bodyText);
  const text = bodyText.toLowerCase();
  if (responseStatus === 401 || responseStatus === 403) {
    if (text.includes("cf-aig-authorization") || text.includes("authenticated gateway")) {
      return {
        status: "gateway_auth",
        message: withErrorDetail("Missing or invalid CF_AIG auth token", detail),
      };
    }
    return {
      status: "missing_key",
      message: withErrorDetail("Provider key missing/invalid for this model alias", detail),
    };
  }

  if (
    text.includes("api key") ||
    text.includes("byok") ||
    text.includes("alias") ||
    text.includes("credential")
  ) {
    return {
      status: "missing_key",
      message: withErrorDetail("Provider key missing/invalid for this model alias", detail),
    };
  }

  if (
    responseStatus === 404 ||
    responseStatus === 422 ||
    text.includes("model") ||
    text.includes("unsupported")
  ) {
    return {
      status: "invalid_model",
      message: withErrorDetail("Model id is not available for this provider", detail),
    };
  }

  if (detail) {
    return {
      status: "error",
      message: `Gateway ${responseStatus}: ${detail}`,
    };
  }

  return {
    status: "error",
    message: `Gateway returned ${responseStatus} (${DIAGNOSTIC_TAG})`,
  };
}

function normalizeErrorText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateErrorText(value: string): string {
  if (value.length <= MAX_GATEWAY_ERROR_MESSAGE_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_GATEWAY_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = normalizeErrorText(value);
      if (normalized) return truncateErrorText(normalized);
    }
  }
  return null;
}

function extractErrorFromJson(payload: unknown): string | null {
  if (!payload) return null;
  if (typeof payload === "string") {
    const normalized = normalizeErrorText(payload);
    return normalized ? truncateErrorText(normalized) : null;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractErrorFromJson(item);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;

  const direct = firstString([
    obj.message,
    obj.detail,
    obj.description,
    obj.reason,
    obj.msg,
  ]);
  if (direct) return direct;

  const errorNode = obj.error;
  if (typeof errorNode === "string") {
    const normalized = normalizeErrorText(errorNode);
    if (normalized) return truncateErrorText(normalized);
  }
  if (errorNode && typeof errorNode === "object") {
    const nested = extractErrorFromJson(errorNode);
    if (nested) return nested;
  }

  if (Array.isArray(obj.errors)) {
    for (const err of obj.errors) {
      const nested = extractErrorFromJson(err);
      if (nested) return nested;
    }
  }

  // As a last resort, surface a compact snapshot of the payload so local debugging
  // is still possible when providers return schema-less 4xx JSON.
  try {
    const snapshot = JSON.stringify(obj);
    const normalized = normalizeErrorText(snapshot);
    if (normalized && normalized !== "{}") {
      return truncateErrorText(normalized);
    }
  } catch {
    // Ignore stringify issues and return null below.
  }

  return null;
}

function extractGatewayErrorDetail(bodyText: string): string | null {
  const normalizedBody = normalizeErrorText(bodyText);
  if (!normalizedBody) return null;

  try {
    const parsed = JSON.parse(normalizedBody) as unknown;
    return extractErrorFromJson(parsed);
  } catch {
    return truncateErrorText(normalizedBody);
  }
}

function withErrorDetail(baseMessage: string, detail: string | null): string {
  if (!detail) return baseMessage;
  const normalizedBase = normalizeErrorText(baseMessage).toLowerCase();
  if (detail.toLowerCase().includes(normalizedBase)) {
    return detail;
  }
  return `${baseMessage}: ${detail}`;
}

async function probeModel(
  env: Env,
  entry: ParsedCatalogEntry,
): Promise<AiModelOption> {
  const { accountId, gatewayId } = getGatewayConfig(env);
  if (!accountId || !gatewayId) {
    return {
      ...entry,
      configured: false,
      status: "error",
      message: "CF_AI_GATEWAY_ACCOUNT_ID / CF_AI_GATEWAY_ID missing",
    };
  }

  const url =
    `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}` +
    "/compat/chat/completions";
  const headers = new Headers({
    "Content-Type": "application/json",
  });

  const gatewayToken = env.CF_AIG_AUTH_TOKEN?.trim();
  if (gatewayToken) {
    headers.set("cf-aig-authorization", `Bearer ${gatewayToken}`);
  }
  if (entry.byokAlias) {
    headers.set("cf-aig-byok-alias", entry.byokAlias);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: entry.model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: "user", content: CHECK_PROMPT }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const classified = classifyProbeError(response.status, body);
      const cfRay = response.headers.get("cf-ray")?.trim();
      const requestId =
        response.headers.get("x-request-id")?.trim() ||
        response.headers.get("cf-request-id")?.trim();
      const hasBody = body.trim().length > 0;
      const hints: string[] = [];
      if (response.statusText) {
        hints.push(response.statusText.trim());
      }
      if (!hasBody) {
        hints.push("empty body");
      }
      if (cfRay) {
        hints.push(`cf-ray:${cfRay}`);
      } else if (requestId) {
        hints.push(`req:${requestId}`);
      }

      let message = classified.message;
      if (!hasBody && message === `Gateway returned ${response.status}`) {
        message = `Gateway ${response.status}${hints.length > 0 ? ` (${hints.join(", ")})` : ""}`;
      } else if (hints.length > 0) {
        message = `${message} (${hints.join(", ")})`;
      }

      if (response.status === 400 && !hasBody) {
        message +=
          ". Check AI Gateway BYOK provider keys and model availability for this exact model id.";
      }

      console.error(
        `[ai-model-catalog] probe failed model=${entry.model} status=${response.status}` +
          `${response.statusText ? ` statusText=${response.statusText}` : ""}` +
          `${cfRay ? ` cfRay=${cfRay}` : ""}` +
          `${requestId ? ` requestId=${requestId}` : ""}` +
          ` body=${truncateErrorText(normalizeErrorText(body || "<empty>"))}`,
      );

      return {
        ...entry,
        configured: false,
        status: classified.status,
        message,
      };
    }

    return {
      ...entry,
      configured: true,
      status: "ready",
    };
  } catch (error) {
    return {
      ...entry,
      configured: false,
      status: "error",
      message: `Probe failed: ${String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildCacheKey(env: Env): string {
  const { accountId, gatewayId } = getGatewayConfig(env);
  return JSON.stringify({
    account: accountId ?? "",
    gateway: gatewayId ?? "",
    auth: env.CF_AIG_AUTH_TOKEN ? "set" : "unset",
    defaultModel: env.CF_AI_DEFAULT_MODEL ?? "",
    catalog: env.CF_AI_MODEL_CATALOG ?? "",
  });
}

function parseTtlMs(value: string | undefined): number {
  if (!value) return CACHE_TTL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return CACHE_TTL_MS;
  return Math.floor(parsed);
}

export async function getAiModelCatalog(
  env: Env,
  options?: { refresh?: boolean },
): Promise<AiModelCatalogResponse> {
  const refresh = options?.refresh === true;
  const cacheKey = buildCacheKey(env);
  const now = Date.now();
  if (!refresh && cache && cache.key === cacheKey && cache.expiresAt > now) {
    return cache.data;
  }

  const defaultModel = env.CF_AI_DEFAULT_MODEL?.trim() || FALLBACK_MODEL;
  const discoveredCatalog =
    parseCatalogFromEnv(env.CF_AI_MODEL_CATALOG, defaultModel) ||
    (await discoverCatalogFromGateway(env, defaultModel)) || {
      source: "default" as const,
      entries: [{
        id: normalizeId(defaultModel),
        label: defaultModel,
        model: defaultModel,
        provider: providerFromModel(defaultModel),
        isDefault: true,
      }],
    };
  const parsedCatalog: ParsedCatalogResult = {
    source: discoveredCatalog.source,
    entries: curateCatalogEntries(discoveredCatalog.entries, defaultModel),
  };
  const checks = await Promise.all(
    parsedCatalog.entries.map((entry) => probeModel(env, entry)),
  );

  const data: AiModelCatalogResponse = {
    ok: true,
    source: parsedCatalog.source,
    checkedAt: new Date().toISOString(),
    models: checks,
  };

  const ttlMs = parseTtlMs(env.CF_AI_MODEL_CHECK_TTL_MS);
  cache = {
    key: cacheKey,
    expiresAt: now + ttlMs,
    data,
  };
  return data;
}
