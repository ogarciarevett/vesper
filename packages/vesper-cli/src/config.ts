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
  return { cli };
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
