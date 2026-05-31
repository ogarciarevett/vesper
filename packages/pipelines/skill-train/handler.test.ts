import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteResult, PipelineContext } from "@vesper/core";
import { skillTrainHandler, skillTrainTaskInput } from "./handler.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FENCE = "```";
const FRONTMATTER = "---\nname: demo\ndescription: a demo skill\n---\n";

/** A fake PipelineContext: a combined target/optimizer resolver + recordRun capture. */
function makeCtx(params: Record<string, unknown>): {
  ctx: PipelineContext;
  recorded: Array<{ status: string; summary: string }>;
} {
  const recorded: Array<{ status: string; summary: string }> = [];
  const complete = async (prompt: string): Promise<CompleteResult> => {
    // The optimizer meta-prompt mentions "optimizer"/"SKILL.md"; return a candidate.
    const text =
      prompt.includes("optimizer") || prompt.includes("SKILL.md")
        ? `${FENCE}markdown\n${FRONTMATTER}IMPROVED body\n${FENCE}`
        : prompt.includes("IMPROVED")
          ? "GOOD"
          : "BAD";
    return { text, exit_code: 0, raw_stdout: text, raw_stderr: "", duration_ms: 1 };
  };

  const ctx: PipelineContext = {
    task: { ...baseTask },
    now: new Date("2026-05-28T00:00:00.000Z"),
    params,
    runId: "run-id",
    parentRunId: null,
    complete,
    recordRun({ status, summary }) {
      recorded.push({ status, summary });
      return "run-id";
    },
    emitProgress() {},
    spawn() {
      throw new Error("spawn is not supported in this fake context");
    },
  };
  return { ctx, recorded };
}

const baseTask = {
  id: "skill-train",
  kind: "manual" as const,
  schedule_expr: "",
  handler_id: "skill-train",
  enabled: true,
  last_run_at: null,
  last_error: null,
  max_runs_per_day: null,
  max_concurrent: null,
  max_duration_ms: 600_000,
  runs_today: 0,
  runs_today_date: null,
  attempt_count: 0,
  next_attempt_at: null,
  required_capabilities: [
    "CLI_INVOKE",
    "READ_STORAGE",
    "WRITE_STORAGE",
    "FS_READ",
    "FS_WRITE",
  ] as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skillTrainHandler", () => {
  let dir: string;
  let skillsDir: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vesper-skilltrain-pipe-"));
    skillsDir = join(dir, "skills");
    stateDir = join(dir, "state");
    mkdirSync(join(skillsDir, "demo"), { recursive: true });
    writeFileSync(join(skillsDir, "demo", "SKILL.md"), `${FRONTMATTER}ORIGINAL body\n`);
    writeFileSync(
      join(skillsDir, "demo", "tasks.json"),
      JSON.stringify([
        { id: "t1", prompt: "q1", expected: "GOOD" },
        { id: "t2", prompt: "q2", expected: "GOOD" },
      ]),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("trains, persists the improved best, and records an ok run", async () => {
    const { ctx, recorded } = makeCtx({
      skill: "demo",
      skillsDir,
      stateDir,
      epochs: "1",
      batchsize: "2",
    });

    await skillTrainHandler(ctx);

    // Persisted the improved candidate.
    const best = await Bun.file(join(stateDir, "demo", "best.md")).text();
    expect(best).toContain("IMPROVED");
    // History has one epoch line.
    const history = await Bun.file(join(stateDir, "demo", "history.jsonl")).text();
    expect(history.trim().split("\n")).toHaveLength(1);
    // Recorded an ok run mentioning the improvement.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status).toBe("ok");
    expect(recorded[0]?.summary).toContain("improved");
  });

  test("dry-run does not write best.md and records the dry-run", async () => {
    const { ctx, recorded } = makeCtx({
      skill: "demo",
      skillsDir,
      stateDir,
      epochs: "1",
      batchsize: "2",
      dryRun: "true",
    });

    await skillTrainHandler(ctx);

    expect(await Bun.file(join(stateDir, "demo", "best.md")).exists()).toBe(false);
    expect(recorded[0]?.summary).toContain("dry-run");
  });

  test("throws when required params are missing", async () => {
    const { ctx } = makeCtx({ skill: "demo" }); // no skillsDir/stateDir
    await expect(skillTrainHandler(ctx)).rejects.toThrow();
  });

  test("throws on a non-integer epochs param", async () => {
    const { ctx } = makeCtx({ skill: "demo", skillsDir, stateDir, epochs: "2.7" });
    await expect(skillTrainHandler(ctx)).rejects.toThrow();
  });

  test("declares the broadest capability set", () => {
    expect(skillTrainTaskInput.required_capabilities).toEqual([
      "CLI_INVOKE",
      "READ_STORAGE",
      "WRITE_STORAGE",
      "FS_READ",
      "FS_WRITE",
    ]);
  });
});
