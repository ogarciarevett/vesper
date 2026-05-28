#!/usr/bin/env bun
// Regenerate docs/CLI.md from the live `vesper` command registry.
// Run via `bun run docs:cli`. The pre-commit hook fails if the committed file is stale.

import { join } from "node:path";
import { renderCliDocs } from "../packages/vesper-cli/src/cli-docs.ts";
import { registry } from "../packages/vesper-cli/src/commands/index.ts";

const OUT = join(import.meta.dir, "..", "docs", "CLI.md");

await Bun.write(OUT, renderCliDocs(registry));
console.log(`wrote ${OUT}`);
