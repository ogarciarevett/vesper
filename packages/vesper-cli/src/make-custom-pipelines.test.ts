import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompleteFn, HandlerRegistry, openStore, Scheduler, type Store } from "@vesper/core";
import {
  type CustomPipelineDeps,
  grantedCapabilities,
  ORCHESTRATION_CONTRACTS,
} from "@vesper/pipelines";
import { improveModelRows, makeCustomPipelinesSurface } from "./make-custom-pipelines.ts";

describe("makeCustomPipelinesSurface", () => {
  let dir: string;
  let db: Database;
  let store: Store;
  let scheduler: Scheduler;
  let registry: HandlerRegistry;

  const completeReplies: string[] = [];
  const complete: CompleteFn = async () => {
    const text = completeReplies.shift() ?? "no reply";
    return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
  };

  beforeEach(() => {
    completeReplies.length = 0;
    dir = mkdtempSync(join(tmpdir(), "vesper-custom-surface-"));
    const path = join(dir, "test.db");
    store = openStore(path);
    db = new Database(path);
    registry = new HandlerRegistry();
    scheduler = new Scheduler({ db, registry, grants: grantedCapabilities() });
  });

  afterEach(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function surface() {
    const deps: CustomPipelineDeps = {
      getDoc: (id) => {
        const row = store.getCustomPipeline(id);
        return row !== null && row.status === "active" ? row.doc : null;
      },
      contracts: ORCHESTRATION_CONTRACTS,
    };
    return makeCustomPipelinesSurface({
      store,
      scheduler,
      registry,
      deps,
      complete,
      modelRows: () => [
        { id: "gpt", cli: "codex", tier: "frontier", passAt1: 0.7, meanCostUsd: 0.9 },
      ],
    });
  }

  const doc: Record<string, unknown> = {
    v: 1,
    name: "Brief",
    stages: [{ tasks: [{ kind: "prompt", id: "a", title: "A", prompt: "go" }] }],
  };

  test("save validates, persists, registers the task, and audits", () => {
    const s = surface();
    const outcome = s.save("brief", doc);
    expect(outcome.ok).toBe(true);
    expect(outcome.capabilities).toContain("CLI_INVOKE");

    expect(store.getCustomPipeline("brief")?.status).toBe("active");
    expect(scheduler.list().some((t) => t.id === "custom:brief")).toBe(true);
    expect(
      store.listEvents({ source: "custom-pipelines", kind: "custom_pipeline_saved" }),
    ).toHaveLength(1);

    expect(s.list().map((r) => r.id)).toEqual(["brief"]);
    expect(s.get("brief")?.doc).toEqual(doc);
  });

  test("save rejects an invalid id or doc without persisting", () => {
    const s = surface();
    expect(s.save("Bad Id", doc).ok).toBe(false);
    expect(s.save("ok-id", { v: 1 }).ok).toBe(false);
    expect(store.getCustomPipeline("ok-id")).toBeNull();
    expect(s.validate(doc).ok).toBe(true);
    expect(s.validate({ v: 1 }).ok).toBe(false);
  });

  test("archive unregisters the task and hides the pipeline", () => {
    const s = surface();
    s.save("brief", doc);
    expect(s.archive("brief")).toBe(true);
    expect(scheduler.list().some((t) => t.id === "custom:brief")).toBe(false);
    expect(s.get("brief")).toBeNull();
    expect(s.archive("missing")).toBe(false);
    // The row survives (Hard rule 4) — only its status flipped.
    expect(store.getCustomPipeline("brief")?.status).toBe("archived");
  });

  test("improve runs the audit through the CLI seam and parses the proposal", async () => {
    const s = surface();
    s.save("brief", doc);
    completeReplies.push(
      '```json\n{"steps":[{"id":"a","model":"gpt","reason":"cheap frontier"}],"warnings":["w"],"notes":"n"}\n```',
    );
    const proposal = await s.improve("brief");
    expect(proposal?.steps[0]?.model).toBe("gpt");
    expect(proposal?.warnings).toEqual(["w"]);

    expect(await s.improve("missing")).toBeNull();
  });

  test("improveModelRows joins the catalog with the benchmark snapshot", () => {
    const rows = improveModelRows(
      { gpt: { cli: "codex", flag: "gpt-5.5", tier: "frontier", benchmarkNames: ["gpt-5-5"] } },
      [
        {
          id: "x",
          source: "deepswe",
          fetchedAt: 1,
          generatedAt: null,
          model: "gpt-5-5",
          harness: null,
          reasoningEffort: null,
          config: null,
          passRate: null,
          passAt1: 0.71,
          meanCostUsd: 0.88,
          medianCostUsd: null,
          meanInputTokens: null,
          meanOutputTokens: null,
          meanDurationSeconds: null,
          rawJson: "{}",
        },
      ],
    );
    expect(rows).toEqual([
      { id: "gpt", cli: "codex", tier: "frontier", passAt1: 0.71, meanCostUsd: 0.88 },
    ]);
  });
});
