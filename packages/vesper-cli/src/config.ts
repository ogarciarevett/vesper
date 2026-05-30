import type { AgentMatcherSpec } from "@vesper/core";
import { configPath } from "./paths.ts";

/** Per-adapter overrides for a CLI tool's headless invocation. */
export interface AdapterConfig {
  readonly command?: string;
  readonly args?: readonly string[];
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

  const presence = normalizePresence(raw.presence);
  return presence !== undefined ? { ...base, presence } : base;
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
