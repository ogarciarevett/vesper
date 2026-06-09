/**
 * `vesper models` — the model-intelligence surface (specs/orchestrator-home.md,
 * slice D). Shows the trusted benchmark snapshot (DeepSWE) joined with the
 * invocable catalog, and what the selector would pick per difficulty. Reads the
 * store directly, so it works with the daemon down.
 */

import {
  BENCHMARK_SOURCE,
  type ModelsConfig,
  openStore,
  selectModel,
  type TaskDifficulty,
} from "@vesper/core";
import { effectiveCatalog } from "../cli-resolver.ts";
import { loadConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath } from "../paths.ts";
import { cyan, dim, line, table } from "../ui.ts";

const DIFFICULTIES: readonly TaskDifficulty[] = ["easy", "medium", "hard"];

function pct(value: number | null): string {
  return value === null ? dim("-") : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
  return value === null ? dim("-") : `$${value.toFixed(2)}`;
}

const listCommand: Command = {
  name: "list",
  summary: "Show the benchmark snapshot and what the selector picks per difficulty.",
  usage: "vesper models list",
  async run() {
    const config = await loadConfig();
    const models: ModelsConfig = {
      ...(config.models?.default !== undefined ? { default: config.models.default } : {}),
      catalog: effectiveCatalog(config),
    };

    const store = openStore(dbPath());
    try {
      const rows = store.getModelBenchmarks(BENCHMARK_SOURCE);
      if (rows.length === 0) {
        line(
          dim(
            "no benchmark snapshot yet — run `vesper schedule run benchmark-ingest` " +
              "(or wait for the daily cron)",
          ),
        );
      } else {
        const fetchedAt = Math.max(...rows.map((r) => r.fetchedAt));
        line(dim(`source ${BENCHMARK_SOURCE} — snapshot ${new Date(fetchedAt).toISOString()}`));
        const sorted = [...rows].sort((a, b) => (b.passAt1 ?? 0) - (a.passAt1 ?? 0));
        line(
          table(
            ["model", "harness", "pass@1", "mean cost"],
            sorted.map((r) => [
              cyan(r.model),
              r.harness ?? dim("-"),
              pct(r.passAt1),
              usd(r.meanCostUsd),
            ]),
          ),
        );
      }

      line("");
      line("Selector picks (cost + intelligence):");
      for (const difficulty of DIFFICULTIES) {
        const choice = selectModel(rows, models, difficulty);
        line(
          choice === undefined
            ? `  ${difficulty.padEnd(6)} ${dim("(no pick — configured default CLI behavior)")}`
            : `  ${difficulty.padEnd(6)} ${cyan(choice.canonicalId)} (${choice.cli} --model ${choice.flag}) ${dim(`— ${choice.reason}`)}`,
        );
      }
      return 0;
    } finally {
      store.close();
    }
  },
};

/** `vesper models ...` — benchmark snapshot + model routing. */
export const modelsGroup: CommandGroup = {
  name: "models",
  summary: "Inspect model benchmarks (DeepSWE) and cost-aware routing picks.",
  subcommands: [listCommand],
};
