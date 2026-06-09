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
      // listRuns is oldest-first; `--limit` should show the most RECENT N, so take
      // the tail (still rendered oldest-first). The local runs table is small.
      const all = store.listRuns({
        ...(pipeline !== undefined ? { pipeline } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      const runs = limit !== undefined ? all.slice(-limit) : all;
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

const replayCommand: Command = {
  name: "replay",
  summary: "Replay a run's full event stream terminal-style (io prompts/outputs included).",
  usage: "vesper runs replay <runId>",
  run({ positionals }) {
    const runId = positionals[0];
    if (runId === undefined) throw new Error("usage: vesper runs replay <runId>");
    const store = openStore(dbPath());
    try {
      const run = store.listRuns({}).find((r) => r.id === runId);
      if (run !== undefined) {
        line(`${cyan(run.pipeline)} ${run.status} — ${run.summary}`);
        line("");
      }
      const events = store.listRunEvents({ runId });
      if (events.length === 0 && run === undefined) {
        line(dim(`no run or events found for ${runId}`));
        return 1;
      }
      for (const event of events) {
        const message = typeof event.payload.message === "string" ? event.payload.message : "";
        if (event.kind === "io") {
          // Terminal view: the full prompt/result/error body, indented.
          const data = event.payload.data;
          const body =
            typeof data === "object" && data !== null && !Array.isArray(data)
              ? (data as Record<string, unknown>)
              : {};
          const who = [
            typeof body.cli === "string" ? body.cli : null,
            typeof body.model === "string" ? body.model : null,
          ]
            .filter((x): x is string => x !== null)
            .join(" · ");
          line(
            `${dim(formatTs(event.ts))}  ${cyan(message.toUpperCase().padEnd(7))}${who.length > 0 ? ` ${dim(who)}` : ""}`,
          );
          const text = typeof body.text === "string" ? body.text : "";
          for (const row of text.split("\n")) line(`    ${row}`);
        } else {
          line(`${dim(formatTs(event.ts))}  ${cyan(event.kind.padEnd(8))} ${message}`);
        }
      }
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
  subcommands: [listCommand, replayCommand],
};
