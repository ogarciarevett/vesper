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
  encodeQr,
  KeychainVault,
  type PairingUpdate,
  renderQrTerminal,
  type SetupUpdate,
  type Vault,
} from "@vesper/core";
import { type ConnectionConfig, loadConfig, saveConfig, type VesperConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { uiPort } from "../paths.ts";
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

/** Store a channel token in the vault (stdin value), merge any params, and enable it. */
export async function setToken(
  deps: ConnectionsDeps,
  id: string,
  token: string,
  params: Readonly<Record<string, string>> = {},
): Promise<{ vaultKey: string }> {
  const descriptor = requireDescriptor(id);
  if (token.length === 0) throw new Error("no token provided on stdin");
  const config = await deps.load();
  const existing = config.connections?.[id];
  const vaultKey = existing?.vaultKey ?? descriptor.vaultKeys[0];
  if (vaultKey === undefined) throw new Error(`channel "${id}" declares no vault key`);
  await deps.vault.set(vaultKey, token);
  const merged = { ...existing?.params, ...params };
  const conn: ConnectionConfig = {
    enabled: existing?.enabled ?? true,
    vaultKey,
    allowedHosts: existing?.allowedHosts ?? descriptor.allowedHosts,
    ...(Object.keys(merged).length > 0 ? { params: merged } : {}),
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

/** Build a channel's handler from config (granted caps + vaultKey + hosts + params). */
async function buildHandler(deps: ConnectionsDeps, id: string) {
  const descriptor = requireDescriptor(id);
  const plugin = deps.plugins.find((p) => p.id === id);
  if (plugin === undefined) throw new Error(`channel "${id}" has no handler yet — coming soon`);
  const conn = (await deps.load()).connections?.[id];
  const vaultKey = conn?.vaultKey ?? descriptor.vaultKeys[0];
  if (vaultKey === undefined) throw new Error(`channel "${id}" declares no vault key`);
  const handler = plugin.build({
    granted: CHANNEL_GRANTS,
    vaultKey,
    allowedHosts: conn?.allowedHosts ?? descriptor.allowedHosts,
    ...(conn?.params !== undefined ? { params: conn.params } : {}),
  });
  return { handler, displayName: descriptor.displayName };
}

/** Build the channel's handler and authenticate it (e.g. Telegram getMe). */
export async function testChannel(deps: ConnectionsDeps, id: string): Promise<string> {
  const { handler, displayName } = await buildHandler(deps, id);
  await handler.authenticate(deps.vault);
  return displayName;
}

/** Authenticate the channel, then send a one-off text message to a recipient. */
export async function sendVia(
  deps: ConnectionsDeps,
  id: string,
  chatId: string,
  text: string,
): Promise<string> {
  if (text.length === 0) throw new Error("no message provided on stdin");
  const { handler, displayName } = await buildHandler(deps, id);
  await handler.authenticate(deps.vault);
  await handler.send({ kind: "notify", chatId, text });
  return displayName;
}

/** Convert a daemon `application/x-ndjson` stream into typed updates (pairing or setup). */
async function* ndjsonStream<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const chunk = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (chunk.length > 0) yield JSON.parse(chunk) as T;
      nl = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) yield JSON.parse(tail) as T;
}

/**
 * Render a pairing stream to the terminal: a scannable QR + plain hint while awaiting,
 * a success line on link. Returns the exit code (0 linked, 1 otherwise). Pure over its
 * `print` seam so it is unit-testable without a daemon.
 */
export async function runPairing(
  updates: AsyncIterable<PairingUpdate>,
  print: (text: string) => void,
): Promise<number> {
  for await (const update of updates) {
    if (update.status === "awaiting") {
      print(renderQrTerminal(encodeQr(update.prompt.data)));
      print("");
      print(update.prompt.humanHint);
      print(dim(update.prompt.data));
      print(dim("Waiting for you to scan..."));
    } else if (update.status === "linked") {
      const where = update.chatId !== undefined ? ` (chat ${update.chatId})` : "";
      print(green(`Linked!${where}`));
      return 0;
    } else if (update.status === "error") {
      print(yellow(`Pairing failed: ${update.reason}`));
      return 1;
    } else {
      print(yellow("Pairing expired before a scan completed. Run the command again."));
      return 1;
    }
  }
  return 1;
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

/** Parse `key=value` tokens into a params record (non-secret channel params). */
function parseParams(tokens: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) params[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return params;
}

const setCommand: Command = {
  name: "set",
  summary: "Store a channel credential (stdin) + any key=value params, and enable it.",
  usage: "vesper connections set <id> [key=value ...]   # token via stdin",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) {
      throw new Error("usage: vesper connections set <id> [key=value ...]  (token via stdin)");
    }
    const params = parseParams(positionals.slice(1));
    const token = await readSecret(`Token for ${id}`);
    const { vaultKey } = await setToken(realDeps(), id, token, params);
    line(green(`stored "${id}" (vault key "${vaultKey}") and enabled`));
    line(dim(`run \`vesper connections test ${id}\` to verify, then restart the daemon`));
    return 0;
  },
};

const sendCommand: Command = {
  name: "send",
  summary: "Send a one-off message to a channel recipient (message via stdin).",
  usage: "vesper connections send <id> <chatId>   # message via stdin",
  async run({ positionals }) {
    const id = positionals[0];
    const chatId = positionals[1];
    if (id === undefined || chatId === undefined) {
      throw new Error("usage: vesper connections send <id> <chatId>  (message via stdin)");
    }
    const text = await readSecret("Message");
    const name = await sendVia(realDeps(), id, chatId, text);
    line(green(`sent via ${name}`));
    return 0;
  },
};

const pairCommand: Command = {
  name: "pair",
  summary: "Scan a QR to connect a channel (auto-captures your chat). Daemon must be running.",
  usage: "vesper connections pair <id>",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper connections pair <id>");
    const base = `http://127.0.0.1:${uiPort()}`;
    let res: Response;
    try {
      res = await fetch(`${base}/api/connections/${encodeURIComponent(id)}/pair`, {
        method: "POST",
        headers: { origin: base },
      });
    } catch {
      throw new Error("could not reach the daemon — start it with `vesper daemon start`");
    }
    if (!res.ok || res.body === null) {
      const detail = (await res.text().catch(() => "")).trim();
      throw new Error(`pairing request failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    return runPairing(ndjsonStream<PairingUpdate>(res.body), line);
  },
};

/**
 * Render an auto-onboarding stream to the terminal: progress lines while working, a
 * success line on `configured`, and the manual-token fallback hint on `awaiting_user`.
 * Returns the exit code (0 configured, 1 otherwise). Pure over `print` — unit-testable.
 */
export async function runChannelSetup(
  updates: AsyncIterable<SetupUpdate>,
  print: (text: string) => void,
): Promise<number> {
  for await (const update of updates) {
    if (update.status === "working") {
      print(dim(update.message));
    } else if (update.status === "configured") {
      print(green("Connected! The channel is set up."));
      return 0;
    } else if (update.status === "awaiting_user") {
      print(yellow(update.reason));
      print(dim("Or set the token by hand: vesper connections set <id>"));
      return 1;
    } else {
      print(yellow(`Setup failed: ${update.reason}`));
      return 1;
    }
  }
  return 1;
}

const setupCommand: Command = {
  name: "setup",
  summary: "Auto-connect a token channel — Vesper drives your CLI's browser to create the bot.",
  usage: "vesper connections setup <id>   # Telegram/Discord; daemon must be running",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) throw new Error("usage: vesper connections setup <id>");
    const base = `http://127.0.0.1:${uiPort()}`;
    let res: Response;
    try {
      res = await fetch(`${base}/api/connections/${encodeURIComponent(id)}/setup`, {
        method: "POST",
        headers: { origin: base },
      });
    } catch {
      throw new Error("could not reach the daemon — start it with `vesper daemon start`");
    }
    if (!res.ok || res.body === null) {
      const detail = (await res.text().catch(() => "")).trim();
      throw new Error(`setup request failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    return runChannelSetup(ndjsonStream<SetupUpdate>(res.body), line);
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
  summary: "Connect messaging channels (scan a QR to pair) so the chatbot is reachable remotely.",
  subcommands: [
    listCommand,
    setCommand,
    pairCommand,
    setupCommand,
    testCommand,
    sendCommand,
    enableCommand,
    disableCommand,
  ],
};
