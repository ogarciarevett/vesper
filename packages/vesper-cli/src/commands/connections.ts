/**
 * `vesper connections` — wire the built Connections core to the operator.
 *
 * `list` shows every catalog channel x available (a handler ships) x configured (a
 * token is in the vault) x enabled (config). `set <id>` reads the credential from
 * STDIN (never argv) into the vault and enables the channel in config. `test <id>`
 * authenticates the handler (e.g. Telegram getMe). `enable`/`disable <id>` flip the
 * config flag. Secrets only ever flow through stdin -> the vault; config holds the
 * vault KEY name, never the value.
 */

import {
  CHANNEL_GRANTS,
  CHANNEL_PLUGINS,
  type ChannelPlugin,
  type ChannelState,
  channelById,
  channelStates,
  KeychainVault,
  type Vault,
} from "@vesper/core";
import { type ConnectionConfig, loadConfig, saveConfig, type VesperConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dim, green, line, table, yellow } from "../ui.ts";

/** Injectable seams so the command logic is unit-testable (no Keychain, no disk). */
export interface ConnectionsDeps {
  readonly vault: Vault;
  readonly load: () => Promise<VesperConfig>;
  readonly save: (config: VesperConfig) => Promise<void>;
  /** Channel plugins — only `test` uses these (to build a handler). Defaults to the registry. */
  readonly plugins: readonly ChannelPlugin[];
}

function realDeps(): ConnectionsDeps {
  return {
    vault: new KeychainVault(),
    load: () => loadConfig(),
    save: (config) => saveConfig(config),
    plugins: CHANNEL_PLUGINS,
  };
}

function requireDescriptor(id: string) {
  const descriptor = channelById(id);
  if (descriptor === undefined) {
    throw new Error(`unknown channel "${id}" — run \`vesper connections list\` for the catalog`);
  }
  return descriptor;
}

/** Immutably set one channel's wiring in the config. */
function withConnection(config: VesperConfig, id: string, conn: ConnectionConfig): VesperConfig {
  return { ...config, connections: { ...(config.connections ?? {}), [id]: conn } };
}

/**
 * Read a secret WITHOUT taking it as an argv (which would leak into shell history /
 * the process table). TTY prompts; a pipe is read from stdin. Mirrors `vault set`.
 */
async function readSecret(label: string): Promise<string> {
  if (process.stdin.isTTY) return prompt(`${label}:`) ?? "";
  return (await Bun.stdin.text()).replace(/\n$/, "");
}

/** Resolve every catalog channel's state for display (no `running` — that is daemon-only). */
export async function connectionStates(deps: ConnectionsDeps): Promise<ChannelState[]> {
  const config = await deps.load();
  const storedKeys = await deps.vault.list();
  return channelStates({ wiring: config.connections, storedKeys });
}

/** Store a channel token in the vault (stdin value) and enable it in config. */
export async function setToken(
  deps: ConnectionsDeps,
  id: string,
  token: string,
): Promise<{ vaultKey: string }> {
  const descriptor = requireDescriptor(id);
  if (token.length === 0) throw new Error("no token provided on stdin");
  const config = await deps.load();
  const existing = config.connections?.[id];
  const vaultKey = existing?.vaultKey ?? descriptor.vaultKeys[0];
  if (vaultKey === undefined) throw new Error(`channel "${id}" declares no vault key`);
  await deps.vault.set(vaultKey, token);
  const conn: ConnectionConfig = {
    enabled: existing?.enabled ?? true,
    vaultKey,
    allowedHosts: existing?.allowedHosts ?? descriptor.allowedHosts,
  };
  await deps.save(withConnection(config, id, conn));
  return { vaultKey };
}

/** Flip a channel's enabled flag (creating its wiring if absent). */
export async function setEnabled(
  deps: ConnectionsDeps,
  id: string,
  enabled: boolean,
): Promise<void> {
  const descriptor = requireDescriptor(id);
  const config = await deps.load();
  const existing = config.connections?.[id];
  const vaultKey = existing?.vaultKey ?? descriptor.vaultKeys[0];
  if (vaultKey === undefined) throw new Error(`channel "${id}" declares no vault key`);
  await deps.save(
    withConnection(config, id, {
      enabled,
      vaultKey,
      allowedHosts: existing?.allowedHosts ?? descriptor.allowedHosts,
    }),
  );
}

/** Build the channel's handler and authenticate it (e.g. Telegram getMe). */
export async function testChannel(deps: ConnectionsDeps, id: string): Promise<string> {
  const descriptor = requireDescriptor(id);
  const plugin = deps.plugins.find((p) => p.id === id);
  if (plugin === undefined) throw new Error(`channel "${id}" has no handler yet — coming soon`);
  const config = await deps.load();
  const conn = config.connections?.[id];
  const vaultKey = conn?.vaultKey ?? descriptor.vaultKeys[0];
  if (vaultKey === undefined) throw new Error(`channel "${id}" declares no vault key`);
  const handler = plugin.build({
    granted: CHANNEL_GRANTS,
    vaultKey,
    allowedHosts: conn?.allowedHosts ?? descriptor.allowedHosts,
  });
  await handler.authenticate(deps.vault);
  return descriptor.displayName;
}

function yesNo(value: boolean): string {
  return value ? green("yes") : dim("no");
}

const listCommand: Command = {
  name: "list",
  summary: "List messaging channels with availability, credential, and enabled status.",
  usage: "vesper connections list",
  async run() {
    const states = await connectionStates(realDeps());
    const rows = states.map((s) => [
      s.displayName,
      s.available ? yesNo(true) : dim("coming soon"),
      yesNo(s.configured),
      yesNo(s.enabled),
    ]);
    line(table(["Channel", "Available", "Token set", "Enabled"], rows));
    return 0;
  },
};

const setCommand: Command = {
  name: "set",
  summary: "Store a channel credential (read from stdin) and enable it.",
  usage: "vesper connections set <id>   # token via stdin",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper connections set <id>  (token via stdin)");
    const token = await readSecret(`Token for ${id}`);
    const { vaultKey } = await setToken(realDeps(), id, token);
    line(green(`stored "${id}" (vault key "${vaultKey}") and enabled`));
    line(dim(`run \`vesper connections test ${id}\` to verify, then restart the daemon`));
    return 0;
  },
};

const testCommand: Command = {
  name: "test",
  summary: "Authenticate a channel's stored credential (e.g. Telegram getMe).",
  usage: "vesper connections test <id>",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper connections test <id>");
    const name = await testChannel(realDeps(), id);
    line(green(`${name} authenticated`));
    return 0;
  },
};

const enableCommand: Command = {
  name: "enable",
  summary: "Enable a channel (the daemon starts it on next launch).",
  usage: "vesper connections enable <id>",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper connections enable <id>");
    await setEnabled(realDeps(), id, true);
    line(green(`enabled "${id}"`));
    line(dim("restart the daemon to apply"));
    return 0;
  },
};

const disableCommand: Command = {
  name: "disable",
  summary: "Disable a channel (deregisters it; the stored token is kept).",
  usage: "vesper connections disable <id>",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper connections disable <id>");
    await setEnabled(realDeps(), id, false);
    line(yellow(`disabled "${id}" (token kept in the vault)`));
    line(dim("restart the daemon to apply"));
    return 0;
  },
};

export const connectionsGroup: CommandGroup = {
  name: "connections",
  summary: "Connect messaging channels (Telegram) so the chatbot is reachable remotely.",
  subcommands: [listCommand, setCommand, testCommand, enableCommand, disableCommand],
};
