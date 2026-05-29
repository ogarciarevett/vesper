#!/usr/bin/env bun
// Regenerate docs/CLI.md AND the auto-injected command table in README.md from the
// live `vesper` command registry. Run via `bun run docs:cli`. The pre-commit hook
// fails if either committed file is stale.

import { join } from "node:path";
import { injectReadmeCommands, renderCliDocs } from "../packages/vesper-cli/src/cli-docs.ts";
import { registry } from "../packages/vesper-cli/src/commands/index.ts";

const root = join(import.meta.dir, "..");

const cliDocs = join(root, "docs", "CLI.md");
await Bun.write(cliDocs, renderCliDocs(registry));
console.log(`wrote ${cliDocs}`);

// Inject the same table into README.md between its markers (no-op if absent).
const readmePath = join(root, "README.md");
const readme = await Bun.file(readmePath).text();
const updated = injectReadmeCommands(readme, registry);
if (updated !== readme) {
  await Bun.write(readmePath, updated);
  console.log(`updated ${readmePath}`);
}
