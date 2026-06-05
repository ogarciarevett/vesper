import {
  type AgentMatcherSpec,
  channelById,
  DEFAULT_VOICE_SETTINGS,
  type VoiceBackend,
  type VoiceBrain,
  type VoiceRoute,
  type VoiceSettings,
} from "@vesper/core";
import { configPath } from "./paths.ts";

/** Per-adapter overrides for a CLI tool's headless invocation. */
export interface AdapterConfig {
  readonly command?: string;
  readonly args?: readonly string[];
}

/**
 * Non-secret wiring for one messaging channel (the token itself lives in the vault,
 * keyed by `vaultKey`). `allowedHosts` is the host-allowlist seam for outbound
 * `NETWORK_FETCH`, intersected with the catalog descriptor (narrowed, never widened).
 */
export interface ConnectionConfig {
  readonly enabled: boolean;
  /** NAME of the vault entry holding the channel credential (never the value). */
  readonly vaultKey: string;
  readonly allowedHosts: readonly string[];
  /** Non-secret per-channel params (e.g. WhatsApp `phoneNumberId`). Never a secret. */
  readonly params?: Readonly<Record<string, string>>;
}

/** The `~/.vesper/config.json` shape. */
export interface VesperConfig {
  readonly cli: {
    /** Name of the default CLI adapter (e.g. "claude"). */
    readonly default?: string;
    /** Per-adapter command/args overrides, keyed by adapter name. */
    readonly adapters: Readonly<Record<string, AdapterConfig>>;
  };
  readonly storage?: {
    /** When true, run summaries are stored as size-only metadata (no raw CLI output). */
    readonly redactRunSummaries?: boolean;
  };
  /** Tuning for the Vesper World live agent-presence ("echo") detector. */
  readonly presence?: {
    /** Extra agent matchers, appended to the built-in allowlist. */
    readonly matchers?: readonly AgentMatcherSpec[];
    /** How often to re-scan for running agents (ms). */
    readonly pollMs?: number;
  };
  /** Vesper World UI preferences. */
  readonly ui?: {
    /** Default renderer theme id (e.g. "hearth", "cyberpunk"). Unknown ids fall back. */
    readonly theme?: string;
  };
  /** Per-channel messaging wiring (Connections). Secrets stay in the vault. */
  readonly connections?: Readonly<Record<string, ConnectionConfig>>;
  /** Proactive-notification routing for `ctx.notify` (pipeline -> connected channel). */
  readonly notify?: {
    /**
     * Catalog channel id `ctx.notify` delivers through when a pipeline names none.
     * When unset the host resolves the first enabled+running channel with a paired
     * destination. An unknown id is dropped during normalization.
     */
    readonly defaultChannel?: string;
  };
  /**
   * Voice-phase settings ("Talk to Vesper"). Fully local by default (Whisper STT +
   * system TTS, brain on the CLI). Present only when the user set `voice`; the host
   * falls back to {@link DEFAULT_VOICE_SETTINGS} when absent.
   */
  readonly voice?: VoiceSettings;
}

/** A fresh config with no default and no overrides. */
export const DEFAULT_CONFIG: VesperConfig = { cli: { adapters: {} } };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeAdapter(raw: unknown): AdapterConfig {
  if (!isObject(raw)) return {};
  const adapter: { command?: string; args?: string[] } = {};
  const command = asString(raw.command);
  if (command !== undefined) adapter.command = command;
  if (Array.isArray(raw.args)) {
    adapter.args = raw.args.filter((value): value is string => typeof value === "string");
  }
  return adapter;
}

/** Compile-check a regex source; true if `new RegExp(source)` succeeds. */
function isValidRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate one untrusted agent-matcher spec from config. Returns the spec only
 * when it is fully well-formed (required string fields, a known kind, and
 * compilable `pattern`/`exclude` regexes); otherwise undefined so the caller can
 * drop it. Never throws on bad input.
 */
function normalizeMatcher(raw: unknown): AgentMatcherSpec | undefined {
  if (!isObject(raw)) return undefined;
  const id = asString(raw.id);
  const label = asString(raw.label);
  const pattern = asString(raw.pattern);
  const kind = raw.kind;
  if (id === undefined || label === undefined || pattern === undefined) return undefined;
  if (kind !== "cli" && kind !== "app") return undefined;
  if (!isValidRegex(pattern)) return undefined;
  const exclude = asString(raw.exclude);
  if (exclude !== undefined && !isValidRegex(exclude)) return undefined;
  return exclude !== undefined
    ? { id, label, kind, pattern, exclude }
    : { id, label, kind, pattern };
}

/** Coerce untrusted `presence` config; drops invalid matchers and out-of-range polls. */
function normalizePresence(raw: unknown): VesperConfig["presence"] | undefined {
  if (!isObject(raw)) return undefined;
  const matchers = Array.isArray(raw.matchers)
    ? raw.matchers.map(normalizeMatcher).filter((m): m is AgentMatcherSpec => m !== undefined)
    : [];
  const pollMs =
    typeof raw.pollMs === "number" && Number.isFinite(raw.pollMs) && raw.pollMs > 0
      ? raw.pollMs
      : undefined;
  if (matchers.length === 0 && pollMs === undefined) return undefined;
  if (matchers.length > 0 && pollMs !== undefined) return { matchers, pollMs };
  if (matchers.length > 0) return { matchers };
  return { pollMs };
}

/**
 * Coerce one untrusted connection entry. Returns undefined (dropped) when the id is
 * not a catalog channel or `raw` is not an object. `vaultKey` defaults to the
 * descriptor's first key; `allowedHosts` is INTERSECTED with the descriptor's
 * allowlist (narrowed, never widened) — an omitted list inherits the descriptor's.
 */
function normalizeConnection(id: string, raw: unknown): ConnectionConfig | undefined {
  const descriptor = channelById(id);
  if (descriptor === undefined || !isObject(raw)) return undefined;
  const vaultKey = asString(raw.vaultKey) ?? descriptor.vaultKeys[0];
  if (vaultKey === undefined) return undefined;
  const requested = Array.isArray(raw.allowedHosts)
    ? raw.allowedHosts.filter((h): h is string => typeof h === "string")
    : undefined;
  const allowedHosts =
    requested === undefined
      ? descriptor.allowedHosts
      : requested.filter((h) => descriptor.allowedHosts.includes(h));
  const params = isObject(raw.params)
    ? (Object.fromEntries(
        Object.entries(raw.params).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>)
    : undefined;
  return {
    enabled: raw.enabled === true,
    vaultKey,
    allowedHosts,
    ...(params !== undefined && Object.keys(params).length > 0 ? { params } : {}),
  };
}

/** Coerce untrusted `connections` config; drops entries for unknown channels or bad shape. */
function normalizeConnections(raw: unknown): VesperConfig["connections"] | undefined {
  if (!isObject(raw)) return undefined;
  const result: Record<string, ConnectionConfig> = {};
  for (const [id, value] of Object.entries(raw)) {
    const conn = normalizeConnection(id, value);
    if (conn !== undefined) result[id] = conn;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Coerce untrusted `notify` config. Keeps `defaultChannel` only when it names a
 * known catalog channel (mirrors `normalizeConnection`'s catalog gate); an unknown
 * or non-string id is dropped, never thrown. Returns undefined when nothing valid
 * remains so the host falls back to first-eligible resolution.
 */
function normalizeNotify(raw: unknown): VesperConfig["notify"] | undefined {
  if (!isObject(raw)) return undefined;
  const defaultChannel = asString(raw.defaultChannel);
  if (defaultChannel === undefined || channelById(defaultChannel) === undefined) return undefined;
  return { defaultChannel };
}

const VOICE_ROUTES: ReadonlySet<VoiceRoute> = new Set(["auto", "vesper", "dictate"]);
const VOICE_BRAINS: ReadonlySet<VoiceBrain> = new Set(["cli", "elevenlabs-cai"]);
const VOICE_BACKENDS: ReadonlySet<VoiceBackend> = new Set(["local", "elevenlabs"]);

/** Return `value` only when it is one of the allowed string-union members. */
function asEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const s = asString(value);
  return s !== undefined && s.length > 0 ? s : undefined;
}

/**
 * Coerce untrusted `voice` config into a complete {@link VoiceSettings}. Any unset
 * or invalid field falls back to {@link DEFAULT_VOICE_SETTINGS} (the fully-local
 * default), so a partial config is filled rather than rejected. Returns undefined
 * only when `voice` is absent/not-an-object — the host then uses the default.
 */
function normalizeVoice(raw: unknown): VoiceSettings | undefined {
  if (!isObject(raw)) return undefined;
  const d = DEFAULT_VOICE_SETTINGS;
  return {
    route: asEnum(raw.route, VOICE_ROUTES) ?? d.route,
    brain: asEnum(raw.brain, VOICE_BRAINS) ?? d.brain,
    stt: asEnum(raw.stt, VOICE_BACKENDS) ?? d.stt,
    tts: asEnum(raw.tts, VOICE_BACKENDS) ?? d.tts,
    hotkey: asNonEmptyString(raw.hotkey) ?? d.hotkey,
    model: asNonEmptyString(raw.model) ?? d.model,
    bargeIn: asBool(raw.bargeIn) ?? d.bargeIn,
    speakReplies: asBool(raw.speakReplies) ?? d.speakReplies,
  };
}

/** Coerce untrusted `ui` config; keeps only a string `theme`. */
function normalizeUi(raw: unknown): VesperConfig["ui"] | undefined {
  if (!isObject(raw)) return undefined;
  const theme = asString(raw.theme);
  return theme !== undefined ? { theme } : undefined;
}

/** Coerce untrusted parsed JSON into a valid {@link VesperConfig}. */
export function normalizeConfig(raw: unknown): VesperConfig {
  if (!isObject(raw)) return DEFAULT_CONFIG;
  const cliRaw = isObject(raw.cli) ? raw.cli : {};
  const adaptersRaw = isObject(cliRaw.adapters) ? cliRaw.adapters : {};

  const adapters: Record<string, AdapterConfig> = {};
  for (const [name, value] of Object.entries(adaptersRaw)) {
    adapters[name] = normalizeAdapter(value);
  }

  const defaultName = asString(cliRaw.default);
  const cli = defaultName !== undefined ? { default: defaultName, adapters } : { adapters };

  const storageRaw = isObject(raw.storage) ? raw.storage : {};
  const base: VesperConfig =
    storageRaw.redactRunSummaries === true
      ? { cli, storage: { redactRunSummaries: true } }
      : { cli };

  let result = base;
  const presence = normalizePresence(raw.presence);
  if (presence !== undefined) result = { ...result, presence };
  const ui = normalizeUi(raw.ui);
  if (ui !== undefined) result = { ...result, ui };
  const connections = normalizeConnections(raw.connections);
  if (connections !== undefined) result = { ...result, connections };
  const notify = normalizeNotify(raw.notify);
  if (notify !== undefined) result = { ...result, notify };
  const voice = normalizeVoice(raw.voice);
  if (voice !== undefined) result = { ...result, voice };
  return result;
}

/** Load and normalize the config, returning {@link DEFAULT_CONFIG} if absent. */
export async function loadConfig(path: string = configPath()): Promise<VesperConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return DEFAULT_CONFIG;

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (cause) {
    throw new Error(`config at ${path} is not valid JSON`, { cause });
  }
  return normalizeConfig(raw);
}

/** Write the config as pretty JSON (creating the file if needed). */
export async function saveConfig(config: VesperConfig, path: string = configPath()): Promise<void> {
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}
