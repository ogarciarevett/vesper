import { KeychainVault } from "@vesper/core";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dim, green, line } from "../ui.ts";

function vault(): KeychainVault {
  return new KeychainVault();
}

/**
 * Read a secret value WITHOUT taking it as a shell argument (which would leak
 * into shell history). Interactive terminals are prompted; piped input is read
 * from stdin.
 */
async function readSecret(key: string): Promise<string> {
  if (process.stdin.isTTY) {
    return prompt(`Value for ${key}:`) ?? "";
  }
  return (await Bun.stdin.text()).replace(/\n$/, "");
}

const setCommand: Command = {
  name: "set",
  summary: "Store a secret for a pipeline (value read from stdin, never the command line).",
  usage: "vesper vault set <key>   # value via stdin",
  async run({ positionals }) {
    const key = positionals[0];
    if (key === undefined) throw new Error("usage: vesper vault set <key>  (value via stdin)");
    const value = await readSecret(key);
    if (value.length === 0) throw new Error("no value provided on stdin");
    await vault().set(key, value);
    line(green(`stored "${key}"`));
    return 0;
  },
};

const getCommand: Command = {
  name: "get",
  summary: "Print a stored secret value.",
  usage: "vesper vault get <key>",
  async run({ positionals }) {
    const key = positionals[0];
    if (key === undefined) throw new Error("usage: vesper vault get <key>");
    // Throws VaultError(not_found) for a missing key; the dispatcher prints it and exits non-zero.
    process.stdout.write(`${await vault().get(key)}\n`);
    return 0;
  },
};

const listCommand: Command = {
  name: "list",
  summary: "List stored secret keys (never their values).",
  usage: "vesper vault list",
  async run() {
    const keys = await vault().list();
    if (keys.length === 0) {
      line(dim("no secrets stored"));
      return 0;
    }
    for (const key of keys) line(`  ${key}`);
    return 0;
  },
};

export const vaultGroup: CommandGroup = {
  name: "vault",
  summary: "Manage pipeline-side secrets in the OS keychain.",
  subcommands: [setCommand, getCommand, listCommand],
};
