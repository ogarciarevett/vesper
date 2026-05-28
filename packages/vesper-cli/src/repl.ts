/**
 * Interactive shell for the bare `vesper` invocation: shows the machine's agent
 * face + a status header, then loops reading commands and dispatching them
 * through the same registry the one-shot CLI uses. Entered ONLY when stdin and
 * stdout are interactive TTYs — piped/CI invocations stay one-shot (see index.ts),
 * so scripting is never affected.
 */

import { createInterface } from "node:readline/promises";
import { ipcRequest } from "@vesper/core";
import { agentFace } from "./banner.ts";
import { dispatch, type Registrable } from "./dispatch.ts";
import { socketPath } from "./paths.ts";
import { bold, cyan, dim, line } from "./ui.ts";

const PROMPT = "vesper › ";

/** A parsed REPL line. */
export type ReplAction =
  | { kind: "noop" }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "run"; args: string[] };

/** Classify a typed line. Pure — the dispatch/IO happens in {@link runRepl}. */
export function parseRepl(input: string): ReplAction {
  const t = input.trim();
  if (t === "") return { kind: "noop" };
  if (t === "exit" || t === "quit") return { kind: "exit" };
  if (t === "clear" || t === "cls") return { kind: "clear" };
  if (t === "help" || t === "?") return { kind: "help" };
  return { kind: "run", args: t.split(/\s+/) };
}

/** The compact in-shell command list (no face), reused by `help`. */
export function commandList(registry: readonly Registrable[]): string[] {
  const width = registry.reduce((max, e) => Math.max(max, e.name.length), 0);
  return [
    bold("commands:"),
    ...registry.map((e) => `  ${cyan(e.name.padEnd(width))}  ${e.summary}`),
    dim("  plus: help · clear · exit"),
  ];
}

async function daemonState(): Promise<string> {
  try {
    const res = await ipcRequest(socketPath(), "ping", { timeoutMs: 500 });
    return res.ok ? `running (v${res.version})` : "unexpected response";
  } catch {
    return "stopped";
  }
}

async function printHeader(): Promise<void> {
  const { lines, id } = agentFace();
  const info = [
    "",
    `${bold("vesper")}${dim(` · agent ${id}`)}`,
    dim(`daemon: ${await daemonState()}`),
    "",
    "",
  ];
  lines.forEach((row, i) => {
    const side = info[i] ? `   ${info[i]}` : "";
    line(`${cyan(`  ${row}`)}${side}`);
  });
  line();
  line(dim("type a command · 'help' for the list · 'exit' to quit"));
  line();
}

/** Run the interactive shell. Returns the process exit code. */
export async function runRepl(registry: readonly Registrable[]): Promise<number> {
  await printHeader();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => rl.close());
  try {
    for (;;) {
      let raw: string;
      try {
        raw = await rl.question(cyan(PROMPT));
      } catch {
        break; // EOF (Ctrl-D) or closed
      }
      const action = parseRepl(raw);
      if (action.kind === "noop") continue;
      if (action.kind === "exit") break;
      if (action.kind === "clear") {
        process.stdout.write("\x1b[2J\x1b[H");
        continue;
      }
      if (action.kind === "help") {
        for (const l of commandList(registry)) line(l);
        continue;
      }
      await dispatch(registry, action.args);
    }
  } finally {
    rl.close();
  }
  line(dim("bye."));
  return 0;
}
