#!/usr/bin/env bun
// @vesper/cli — the `vesper` operator command. Resolves argv against the command
// registry and dispatches. Commands live in ./commands/*; the dispatcher (./dispatch.ts)
// handles help and the error boundary.
import { registry } from "./commands/index.ts";
import { dispatch } from "./dispatch.ts";

process.exit(await dispatch(registry, process.argv.slice(2)));
