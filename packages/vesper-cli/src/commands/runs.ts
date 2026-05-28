import { openStore } from "@vesper/core";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath } from "../paths.ts";
import { cyan, dim, line, table } from "../ui.ts";

/** Format a unix-ms timestamp as `YYYY-MM-DD HH:MM:SS`. */
function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

const listCommand: Command = {
  name: "list",
  summary: "List recorded pipeline runs (oldest first).",
  usage: "vesper runs list [--pipeline <name>] [--status <status>] [--limit <n>]",
  run({ flags }) {
    const pipeline = typeof flags.pipeline === "string" ? flags.pipeline : undefined;
    const status = typeof flags.status === "string" ? flags.status : undefined;
    const limitRaw = typeof flags.limit === "string" ? Number(flags.limit) : Number.NaN;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

    // openStore applies migrations and returns a ready Store; close it when done.
    const store = openStore(dbPath());
    try {
      const runs = store.listRuns({
        ...(pipeline !== undefined ? { pipeline } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (runs.length === 0) {
        line(dim("no runs recorded"));
        return 0;
      }
      const rows = runs.map((r) => [formatTs(r.ts), cyan(r.pipeline), r.status, r.summary]);
      line(table(["time", "pipeline", "status", "summary"], rows));
      return 0;
    } finally {
      store.close();
    }
  },
};

/** `vesper runs ...` — read the runs every pipeline writes via `ctx.recordRun`. */
export const runsGroup: CommandGroup = {
  name: "runs",
  summary: "Inspect recorded pipeline runs.",
  subcommands: [listCommand],
};
