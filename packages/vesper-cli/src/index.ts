#!/usr/bin/env bun
// @vesper/cli — the `vesper` operator command. Resolves argv against the command
// registry and dispatches. Commands live in ./commands/*; the dispatcher (./dispatch.ts)
// handles help and the error boundary. Bare `vesper` in an interactive terminal opens
// the REPL shell; with args (or when piped) it stays one-shot and scriptable.
import { registry } from "./commands/index.ts";
import { dispatch } from "./dispatch.ts";
import { runRepl } from "./repl.ts";

const args = process.argv.slice(2);
const interactive =
  args.length === 0 && process.stdin.isTTY === true && process.stdout.isTTY === true;

process.exit(interactive ? await runRepl(registry) : await dispatch(registry, args));
