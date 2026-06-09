/**
 * Tests for the `benchmark-ingest` pipeline — fake fetch + fake store seam; the
 * suite touches no network and no real DB. Covers the ok path, HTTP/JSON
 * failures (fail-soft), the empty-rows keep-previous-snapshot rule, the host
 * allowlist, and the capability gate.
 */

import { describe, expect, test } from "bun:test";
import type { CapabilityError, FetchFn, ModelBenchmarkInput, PipelineContext } from "@vesper/core";
import {
  BENCHMARK_INGEST_HANDLER_ID,
  benchmarkIngestTaskInput,
  createBenchmarkIngestHandler,
} from "./handler.ts";

function makeCtx(capabilities: readonly string[] = ["NETWORK_FETCH", "WRITE_STORAGE"]): {
  ctx: PipelineContext;
  recorded: { status: string; summary: string }[];
} {
  const recorded: { status: string; summary: string }[] = [];
  const ctx = {
    task: {
      id: "benchmark-ingest",
      kind: "cron",
      schedule_expr: "15 6 * * *",
      handler_id: BENCHMARK_INGEST_HANDLER_ID,
      enabled: true,
      last_run_at: null,
      last_error: null,
      max_runs_per_day: 2,
      max_concurrent: null,
      max_duration_ms: 60_000,
      runs_today: 0,
      runs_today_date: null,
      attempt_count: 0,
      next_attempt_at: null,
      required_capabilities: capabilities,
    },
    now: new Date(2026, 5, 9),
    params: {},
    runId: "run-id",
    parentRunId: null,
    recordRun({ status, summary }: { status: string; summary: string }) {
      recorded.push({ status, summary });
      return "run-id";
    },
    emitProgress() {},
  } as unknown as PipelineContext;
  return { ctx, recorded };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const GOOD_DOC = {
  generated_at: "2026-06-07T05:03:42Z",
  rows: [
    { model: "gpt-5-5", pass_at_1: 0.7, mean_cost_usd: 6.6 },
    { model: "claude-opus-4-8", pass_at_1: 0.58, mean_cost_usd: 12.58 },
    { broken: true },
  ],
};

describe("benchmark-ingest", () => {
  test("fetches the allowlisted host only and replaces the snapshot", async () => {
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      urls.push(url);
      return jsonResponse(GOOD_DOC);
    };
    const replaced: { source: string; rows: readonly ModelBenchmarkInput[] }[] = [];
    const handler = createBenchmarkIngestHandler({
      fetchFn,
      replaceBenchmarks: (source, rows) => {
        replaced.push({ source, rows });
        return rows.length;
      },
    });
    const { ctx, recorded } = makeCtx();

    await handler(ctx);

    expect(urls).toEqual(["https://deepswe.datacurve.ai/artifacts/leaderboard-live.json"]);
    expect(replaced[0]?.source).toBe("deepswe");
    expect(replaced[0]?.rows).toHaveLength(2); // the broken row was dropped
    expect(recorded[0]?.status).toBe("ok");
    expect(recorded[0]?.summary).toContain("2 model benchmark rows");
  });

  test("an HTTP error records error and keeps the previous snapshot", async () => {
    let replaceCalls = 0;
    const handler = createBenchmarkIngestHandler({
      fetchFn: async () => new Response("nope", { status: 503 }),
      replaceBenchmarks: () => {
        replaceCalls += 1;
        return 0;
      },
    });
    const { ctx, recorded } = makeCtx();

    await handler(ctx);

    expect(recorded[0]?.status).toBe("error");
    expect(replaceCalls).toBe(0);
  });

  test("an empty/unparseable leaderboard never wipes the snapshot", async () => {
    for (const body of [{ rows: [] }, { nope: true }]) {
      let replaceCalls = 0;
      const handler = createBenchmarkIngestHandler({
        fetchFn: async () => jsonResponse(body),
        replaceBenchmarks: () => {
          replaceCalls += 1;
          return 0;
        },
      });
      const { ctx, recorded } = makeCtx();
      await handler(ctx);
      expect(recorded[0]?.status).toBe("no_change");
      expect(replaceCalls).toBe(0);
    }
  });

  test("a task without NETWORK_FETCH is denied before any fetch", async () => {
    let fetched = 0;
    const handler = createBenchmarkIngestHandler({
      fetchFn: async () => {
        fetched += 1;
        return jsonResponse(GOOD_DOC);
      },
      replaceBenchmarks: () => 0,
    });
    const { ctx } = makeCtx(["WRITE_STORAGE"]);

    const err = await handler(ctx).catch((e: unknown) => e);
    expect((err as CapabilityError).name).toBe("CapabilityError");
    expect(fetched).toBe(0);
  });

  test("the task declares exactly NETWORK_FETCH + WRITE_STORAGE, daily cron", () => {
    expect([...(benchmarkIngestTaskInput.required_capabilities ?? [])].sort()).toEqual([
      "NETWORK_FETCH",
      "WRITE_STORAGE",
    ]);
    expect(benchmarkIngestTaskInput.kind).toBe("cron");
  });
});
