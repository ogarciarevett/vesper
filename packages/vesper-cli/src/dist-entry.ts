#!/usr/bin/env bun
// Publishable CLI entrypoint for the npm distribution (`@ogarciarevett/vesper`).
//
// Same dispatch as `index.ts`, but the UI client assets are EMBEDDED at build time:
// a single bundled file has no `client/` directory and no runtime bundler (see
// `compiled-entry.ts` for the same reasoning), so `vesper ui` would otherwise have
// nothing to serve. `scripts/build-dist.ts` generates the referenced `.txt` files
// immediately before `bun build`; they do not exist in a plain source checkout.
import { setEmbeddedClientAssets } from "@vesper/ui";
import { registry } from "./commands/index.ts";
import { dispatch } from "./dispatch.ts";
import appJs from "./generated/app-js.txt" with { type: "text" };
import indexHtml from "./generated/index-html.txt" with { type: "text" };
import { runRepl } from "./repl.ts";

setEmbeddedClientAssets({ indexHtml, appJs });

// Bare `vesper` in an interactive terminal opens the REPL; with args (or piped) it
// stays one-shot and scriptable — identical to the from-source entry.
const args = process.argv.slice(2);
const interactive =
  args.length === 0 && process.stdin.isTTY === true && process.stdout.isTTY === true;

process.exit(interactive ? await runRepl(registry) : await dispatch(registry, args));
