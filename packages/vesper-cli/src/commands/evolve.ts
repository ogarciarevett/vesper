import { type EventRow, openStore } from "@vesper/core";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath } from "../paths.ts";
import { bold, cyan, dim, line, table } from "../ui.ts";

/** Read a string field from an event payload, or a fallback. */
function field(payload: Record<string, unknown>, key: string, fallback = ""): string {
  const value = payload[key];
  return typeof value === "string" ? value : fallback;
}

/** Format a unix-ms timestamp as `YYYY-MM-DD HH:MM`. */
function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

const listCommand: Command = {
  name: "list",
  summary: "Show the latest auto-evolve report and open skill/fix proposals.",
  usage: "vesper evolve list",
  run() {
    // Read-only: open the store, render, close. No writes.
    const store = openStore(dbPath());
    try {
      const events = store.listEvents({ source: "auto-evolve" });
      if (events.length === 0) {
        line(
          dim("no auto-evolve activity yet — enable it with `vesper schedule enable auto-evolve`"),
        );
        return 0;
      }

      // listEvents is oldest-first; the latest report is the last `report` row.
      const reports = events.filter((e) => e.kind === "report");
      const latest = reports.at(-1);
      if (latest !== undefined) {
        line(bold("Latest report"));
        line(`  ${dim(formatTs(latest.ts))}  ${field(latest.payload, "summary", "(no summary)")}`);
        line();
      }

      renderProposals(
        "Skill proposals",
        events.filter((e) => e.kind === "skill_proposal"),
        (p) => [cyan(field(p, "name")), field(p, "reason")],
      );
      renderProposals(
        "Fix proposals",
        events.filter((e) => e.kind === "fix_proposal"),
        (p) => [cyan(field(p, "signature")), field(p, "proposedFix")],
      );
      return 0;
    } finally {
      store.close();
    }
  },
};

/** Render a titled table of proposal events, or a dim "(none)" when empty. */
function renderProposals(
  title: string,
  rows: readonly EventRow[],
  cells: (payload: Record<string, unknown>) => readonly string[],
): void {
  line(bold(title));
  if (rows.length === 0) {
    line(dim("  (none)"));
    line();
    return;
  }
  line(
    table(
      ["", ""],
      rows.map((r) => cells(r.payload)),
    ),
  );
  line();
}

/** `vesper evolve ...` — read-only view over the auto-evolve report + proposals. */
export const evolveGroup: CommandGroup = {
  name: "evolve",
  summary: "Inspect auto-evolve reports and proposals (read-only).",
  subcommands: [listCommand],
};
