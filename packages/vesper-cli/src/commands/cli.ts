import { createInterface } from "node:readline/promises";
import {
  ADAPTER_REGISTRY,
  buildAdapter,
  CLIError,
  type CLIErrorReason,
  detectAvailableCLIs,
} from "@vesper/core";
import { loadConfig, saveConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { cyan, dim, errorLine, green, type Health, line, statusToken } from "../ui.ts";

/** Probe budget for `cli list`. Tight enough to keep listing snappy, loose enough to not
 *  trip a healthy CLI whose round-trip is 4–6 s. Smaller than the 30 s default for pipelines. */
const LIST_PROBE_TIMEOUT_MS = 8000;

type ListRow = {
  readonly name: string;
  readonly version: string | undefined;
  readonly statusKind: Health;
  readonly statusLabel: string;
  readonly hint: string;
};

/** Map a CLIError reason to a one-line remediation hint shown next to the status. */
function hintFor(name: string, reason: CLIErrorReason | "unknown", errMsg: string): string {
  switch (reason) {
    case "not_installed":
      return `install with \`vesper cli install ${name}\``;
    case "not_authenticated":
      return "not authenticated — sign in via the CLI's docs";
    case "rate_limited":
      return "rate-limited — try later";
    case "timeout":
      return "no response (8s) — hung or rate-limited";
    case "nonzero_exit":
      return errMsg.split("\n")[0]?.trim().slice(0, 80) ?? "error";
    case "unknown":
      return "unknown error";
  }
}

/** Describe a single adapter for `cli list`: version + probe, both gated. */
async function describeCli(name: string, installed: ReadonlySet<string>): Promise<ListRow> {
  if (!installed.has(name)) {
    return {
      name,
      version: undefined,
      statusKind: "bad",
      statusLabel: "not-installed",
      hint: hintFor(name, "not_installed", ""),
    };
  }
  const adapter = buildAdapter(name);
  if (adapter === undefined) {
    return {
      name,
      version: undefined,
      statusKind: "bad",
      statusLabel: "unknown",
      hint: "unknown adapter",
    };
  }

  const [verRes, probeRes] = await Promise.allSettled([
    adapter.version(),
    adapter.probe({ timeoutMs: LIST_PROBE_TIMEOUT_MS }),
  ]);
  const version = verRes.status === "fulfilled" ? verRes.value : undefined;

  if (probeRes.status === "fulfilled") {
    return { name, version, statusKind: "ok", statusLabel: "ok", hint: "" };
  }
  const err = probeRes.reason;
  const reason: CLIErrorReason | "unknown" = err instanceof CLIError ? err.reason : "unknown";
  const errMsg = err instanceof Error ? err.message : String(err);
  const kind: Health = reason === "not_installed" ? "bad" : "warn";
  return {
    name,
    version,
    statusKind: kind,
    statusLabel: reason === "unknown" ? "error" : reason.replace(/_/g, "-"),
    hint: hintFor(name, reason, errMsg),
  };
}

const listCommand: Command = {
  name: "list",
  summary: "List supported CLIs with version, working status, and remediation hints.",
  usage: "vesper cli list",
  async run() {
    const installed = new Set(await detectAvailableCLIs());
    const names = Object.keys(ADAPTER_REGISTRY);
    const rows = await Promise.all(names.map((n) => describeCli(n, installed)));

    const nameW = rows.reduce((m, r) => Math.max(m, r.name.length), 0);
    const verW = rows.reduce((m, r) => Math.max(m, (r.version ?? "—").length), 0);
    for (const r of rows) {
      const ver = (r.version ?? "—").padEnd(verW);
      const status = statusToken(r.statusKind, r.statusLabel);
      const hint = r.hint ? `  ${dim(r.hint)}` : "";
      line(`  ${cyan(r.name.padEnd(nameW))}  ${dim(ver)}  ${status}${hint}`);
    }
    return 0;
  },
};

const selectCommand: Command = {
  name: "select",
  summary: "Set the default CLI adapter (must be installed).",
  usage: "vesper cli select <name>",
  async run({ positionals }) {
    const name = positionals[0];
    if (name === undefined) throw new Error("usage: vesper cli select <name>");
    const installed = await detectAvailableCLIs();
    if (!installed.includes(name)) {
      const detected = installed.length > 0 ? installed.join(", ") : "none";
      throw new Error(`"${name}" is not installed (detected: ${detected})`);
    }
    const config = await loadConfig();
    await saveConfig({ cli: { default: name, adapters: config.cli.adapters } });
    line(green(`default CLI set to "${name}"`));
    return 0;
  },
};

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

type InstallEntry = {
  /** Argv[0]. */
  readonly command: string;
  /** Argv[1..]. */
  readonly args: readonly string[];
  /** Human-readable single-line command shown to the user before running. */
  readonly display: string;
  /** Vendor docs URL printed alongside the command. */
  readonly docsUrl: string;
};

/** Auto-installable CLIs: claude via Anthropic's official curl; rest via `bun add -g`. */
const INSTALL_BY_NAME: Readonly<Record<string, InstallEntry>> = {
  claude: {
    command: "sh",
    args: ["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    display: "curl -fsSL https://claude.ai/install.sh | bash",
    docsUrl: "https://docs.claude.com/en/docs/claude-code",
  },
  codex: {
    command: "bun",
    args: ["add", "-g", "@openai/codex"],
    display: "bun add -g @openai/codex",
    docsUrl: "https://github.com/openai/codex",
  },
  opencode: {
    command: "bun",
    args: ["add", "-g", "opencode-ai"],
    display: "bun add -g opencode-ai",
    docsUrl: "https://github.com/sst/opencode",
  },
  gemini: {
    command: "bun",
    args: ["add", "-g", "@google/gemini-cli"],
    display: "bun add -g @google/gemini-cli",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
  },
  cursor: {
    command: "sh",
    args: ["-c", "curl https://cursor.com/install -fsS | bash"],
    display: "curl https://cursor.com/install -fsS | bash",
    docsUrl: "https://docs.cursor.com/en/cli/overview",
  },
};

/** Bun bootstrap (used only when `bun` is missing and the chosen installer needs it). */
const BUN_INSTALL: InstallEntry = {
  command: "sh",
  args: ["-c", "curl -fsSL https://bun.sh/install | bash"],
  display: "curl -fsSL https://bun.sh/install | bash",
  docsUrl: "https://bun.sh",
};

/** Vesper-family CLIs we know about but don't auto-install yet. Docs link only. */
const MANUAL_BY_NAME: Readonly<Record<string, string>> = {
  "open-claw": "https://github.com/openclaw/openclaw",
  "nano-claw": "https://github.com/nanocoai/nanoclaw",
  "iron-claw": "https://github.com/nearai/ironclaw",
  hermes: "https://github.com/NousResearch/hermes-agent",
};

/** Convenience aliases — accept what users naturally type. */
const ALIAS: Readonly<Record<string, string>> = {
  "cursor-cli": "cursor",
};

/** `which <bin>` exits 0 iff the binary is on PATH. */
async function which(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Read one line; "y"/"yes" (case-insensitive) → true. EOF/Ctrl-D → false. */
async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = await rl.question(prompt);
    const ans = raw.trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/** Run an install command with stdio inherited so the user sees real-time progress. */
async function runInstall(entry: InstallEntry): Promise<number> {
  const proc = Bun.spawn([entry.command, ...entry.args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return await proc.exited;
}

const installCommand: Command = {
  name: "install",
  summary: "Install a supported LLM CLI (claude/codex/opencode/gemini/cursor).",
  usage: "vesper cli install <name>",
  async run({ positionals }) {
    const raw = positionals[0];
    if (raw === undefined) throw new Error("usage: vesper cli install <name>");
    const name = ALIAS[raw] ?? raw;

    // Refuse on non-TTY: install runs a shell installer with confirmation.
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      throw new Error(
        "`vesper cli install` requires an interactive terminal (refuses on pipes/CI)",
      );
    }

    // Manual-only — known to Vesper but not auto-installable.
    const manualUrl = MANUAL_BY_NAME[name];
    if (manualUrl !== undefined) {
      line(`${name} is not auto-installable yet — manual install required.`);
      line(`  docs: ${manualUrl}`);
      return 0;
    }

    const entry = INSTALL_BY_NAME[name];
    if (entry === undefined) {
      const known = Object.keys(INSTALL_BY_NAME).join(", ");
      throw new Error(`unknown CLI "${name}" (supported: ${known})`);
    }

    // Step 0 — already on PATH? Report and exit; do NOT reinstall.
    if (await which(name)) {
      const adapter = buildAdapter(name);
      let version = "";
      if (adapter !== undefined) {
        try {
          version = await adapter.version();
        } catch {
          /* version() may fail if --version flag differs — fall back to no version. */
        }
      }
      line(green(`${name}${version ? ` ${version}` : ""} already installed`));
      return 0;
    }

    // Step 1 — Bun prerequisite for any installer that uses `bun add`.
    if (entry.command === "bun" && !(await which("bun"))) {
      line(`bun is required to install ${name} but is not on PATH.`);
      line(`  proposed: ${BUN_INSTALL.display}`);
      line(`  docs: ${BUN_INSTALL.docsUrl}`);
      if (!(await confirm("install bun first? [y/N] "))) {
        errorLine("aborted — bun not installed");
        return 1;
      }
      const bunExit = await runInstall(BUN_INSTALL);
      if (bunExit !== 0) {
        errorLine(`bun installer exited with code ${bunExit}`);
        return bunExit;
      }
    }

    // Step 2 — Show + confirm + run.
    line(`installing ${name}:`);
    line(`  command: ${entry.display}`);
    line(`  docs: ${entry.docsUrl}`);
    if (!(await confirm("proceed? [y/N] "))) {
      errorLine("aborted");
      return 1;
    }
    const exit = await runInstall(entry);
    if (exit !== 0) {
      errorLine(`${name} installer exited with code ${exit}`);
      return exit;
    }

    // Re-probe and report the new status.
    const after = buildAdapter(name);
    if (after === undefined) {
      line(green(`${name} installed`));
      return 0;
    }
    let version = "";
    try {
      version = await after.version();
    } catch {
      /* ignore */
    }
    line(green(`${name}${version ? ` ${version}` : ""} installed`));
    try {
      await after.probe({ timeoutMs: LIST_PROBE_TIMEOUT_MS });
      line(green("  probe: ok"));
    } catch (err) {
      const reason: CLIErrorReason | "unknown" = err instanceof CLIError ? err.reason : "unknown";
      line(`  probe: ${reason === "unknown" ? "error" : reason.replace(/_/g, "-")}`);
    }
    return 0;
  },
};

export const cliGroup: CommandGroup = {
  name: "cli",
  summary: "Inspect, select, and install the LLM CLI Vesper orchestrates.",
  subcommands: [listCommand, selectCommand, installCommand],
};
