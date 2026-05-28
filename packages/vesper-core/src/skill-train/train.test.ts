import { describe, expect, test } from "bun:test";
import type { CompleteFn } from "../scheduler/types.ts";
import { SkillTrainError } from "./errors.ts";
import { splitTasks, trainSkill } from "./train.ts";
import type { HistoryEntry, Scorer, Skill, SkillTask, TrajectoryResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRONTMATTER = "---\nname: demo\ndescription: a demo skill\n---\n";

function makeSkill(bodyTail: string, tasks: Skill["tasks"]): Skill {
  return {
    name: "demo",
    body: `${FRONTMATTER}${bodyTail}`,
    frontmatter: { name: "demo", description: "a demo skill" },
    tasks,
  };
}

/** Wrap a (prompt -> text) function as a CompleteFn returning a full result. */
function makeComplete(fn: (prompt: string) => string): CompleteFn {
  return async (prompt) => ({
    text: fn(prompt),
    exit_code: 0,
    raw_stdout: fn(prompt),
    raw_stderr: "",
    duration_ms: 1,
  });
}

/** A candidate SKILL.md (frontmatter preserved) wrapped in a markdown fence. */
function candidateFence(bodyTail: string): string {
  const fence = "```";
  return `${fence}markdown\n${FRONTMATTER}${bodyTail}\n${fence}`;
}

// The target "model": replies GOOD only when the skill body says IMPROVED.
const target = makeComplete((prompt) => (prompt.includes("IMPROVED") ? "GOOD" : "BAD"));

const TASKS: Skill["tasks"] = [
  { id: "t1", prompt: "q1", expected: "GOOD" },
  { id: "t2", prompt: "q2", expected: "GOOD" },
];

const ISO = () => "2026-05-28T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trainSkill", () => {
  test("accepts a strictly-better candidate and adopts its body", async () => {
    const optimizer = makeComplete(() => candidateFence("IMPROVED body"));
    const skill = makeSkill("ORIGINAL body", TASKS);

    const result = await trainSkill({
      skill,
      complete: target,
      optimizerComplete: optimizer,
      epochs: 1,
      batchSize: 2,
      targetCli: "claude",
      optimizerCli: "codex",
      now: ISO,
    });

    expect(result.baselineScore).toBe(0); // original body -> "BAD" -> no "GOOD"
    expect(result.bestScore).toBe(1); // improved body -> "GOOD"
    expect(result.accepted).toBe(true);
    expect(result.bestBody).toContain("IMPROVED");
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.accepted).toBe(true);
    expect(result.history[0]?.priorBestScore).toBe(0);
    expect(result.history[0]?.candidateScore).toBe(1);
    expect(result.history[0]?.optimizerCli).toBe("codex");
  });

  test("dry-run scores the candidate but never adopts it", async () => {
    const optimizer = makeComplete(() => candidateFence("IMPROVED body"));
    const skill = makeSkill("ORIGINAL body", TASKS);

    const result = await trainSkill({
      skill,
      complete: target,
      optimizerComplete: optimizer,
      epochs: 1,
      batchSize: 2,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
      dryRun: true,
    });

    expect(result.accepted).toBe(false);
    expect(result.bestBody).toContain("ORIGINAL");
    expect(result.bestScore).toBe(0);
    expect(result.history[0]?.candidateScore).toBe(1); // still scored
    expect(result.history[0]?.accepted).toBe(false);
  });

  test("a candidate that does not beat the baseline is rejected", async () => {
    // Optimizer keeps the body un-improved -> candidate scores the same (0) -> not accepted.
    const optimizer = makeComplete(() => candidateFence("STILL ORIGINAL"));
    const skill = makeSkill("ORIGINAL body", TASKS);

    const result = await trainSkill({
      skill,
      complete: target,
      optimizerComplete: optimizer,
      epochs: 1,
      batchSize: 2,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
    });

    expect(result.accepted).toBe(false);
    expect(result.bestBody).toContain("ORIGINAL body");
  });

  test("an unparseable optimizer response is a failed epoch, not a throw", async () => {
    const optimizer = makeComplete(() => "no fence, no frontmatter, just noise");
    const skill = makeSkill("ORIGINAL body", TASKS);

    const result = await trainSkill({
      skill,
      complete: target,
      optimizerComplete: optimizer,
      epochs: 2,
      batchSize: 1,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
    });

    expect(result.accepted).toBe(false);
    expect(result.history).toHaveLength(2);
    expect(result.history.every((h) => !h.accepted)).toBe(true);
  });

  test("calls the onEpoch hook once per epoch with the batch trajectories", async () => {
    const optimizer = makeComplete(() => candidateFence("IMPROVED body"));
    const skill = makeSkill("ORIGINAL body", TASKS);
    const seen: Array<{ entry: HistoryEntry; count: number }> = [];

    await trainSkill({
      skill,
      complete: target,
      optimizerComplete: optimizer,
      epochs: 2,
      batchSize: 1,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
      onEpoch: (entry, trajectories: readonly TrajectoryResult[]) => {
        seen.push({ entry, count: trajectories.length });
      },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.count).toBe(1); // batchSize 1
    expect(seen[0]?.entry.epoch).toBe(1);
    expect(seen[1]?.entry.epoch).toBe(2);
  });

  test("uses the target resolver as the optimizer when none is provided", async () => {
    // Single resolver that, given the optimizer meta-prompt, returns a candidate;
    // given a task prompt, behaves like the target.
    const combined = makeComplete((prompt) =>
      prompt.includes("optimizer") || prompt.includes("SKILL.md")
        ? candidateFence("IMPROVED body")
        : prompt.includes("IMPROVED")
          ? "GOOD"
          : "BAD",
    );
    const skill = makeSkill("ORIGINAL body", TASKS);

    const result = await trainSkill({
      skill,
      complete: combined,
      epochs: 1,
      batchSize: 2,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
    });

    expect(result.accepted).toBe(true);
  });

  test("a judge task without a configured judge rejects the run", async () => {
    const optimizer = makeComplete(() => candidateFence("IMPROVED body"));
    const skill = makeSkill("ORIGINAL body", [
      { id: "j", prompt: "q", expected: "x", scorer: "judge" },
    ]);

    await expect(
      trainSkill({
        skill,
        complete: target,
        optimizerComplete: optimizer,
        epochs: 1,
        batchSize: 1,
        targetCli: "claude",
        optimizerCli: "claude",
        now: ISO,
      }),
    ).rejects.toBeInstanceOf(SkillTrainError);
  });

  test("a judge task uses the injected judge scorer", async () => {
    const judge: Scorer = () => 1;
    const optimizer = makeComplete(() => candidateFence("ORIGINAL body")); // no improvement needed
    const skill = makeSkill("ORIGINAL body", [
      { id: "j", prompt: "q", expected: "x", scorer: "judge" },
    ]);

    const result = await trainSkill({
      skill,
      complete: target,
      optimizerComplete: optimizer,
      judge,
      epochs: 1,
      batchSize: 1,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
    });

    expect(result.baselineScore).toBe(1); // judge always returns 1
  });

  test("rejects invalid epochs / batchSize", async () => {
    const skill = makeSkill("ORIGINAL body", TASKS);
    const base = {
      skill,
      complete: target,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
    };
    await expect(trainSkill({ ...base, epochs: 0, batchSize: 1 })).rejects.toBeInstanceOf(
      SkillTrainError,
    );
    await expect(trainSkill({ ...base, epochs: 1, batchSize: 0 })).rejects.toBeInstanceOf(
      SkillTrainError,
    );
  });
});

describe("splitTasks", () => {
  const tasks: SkillTask[] = [
    { id: "a", prompt: "p", expected: "e" },
    { id: "b", prompt: "p", expected: "e" },
    { id: "c", prompt: "p", expected: "e" },
    { id: "d", prompt: "p", expected: "e" },
  ];

  test("no fraction => both sets are the full list (no split)", () => {
    const { trainTasks, valTasks } = splitTasks(tasks);
    expect(trainTasks).toBe(tasks);
    expect(valTasks).toBe(tasks);
  });

  test("0.5 of 4 tasks => 2 validation (first), 2 training (rest), deterministic", () => {
    const { trainTasks, valTasks } = splitTasks(tasks, 0.5);
    expect(valTasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(trainTasks.map((t) => t.id)).toEqual(["c", "d"]);
  });

  test("clamps to leave at least one training task", () => {
    const { trainTasks, valTasks } = splitTasks(tasks, 0.99);
    expect(valTasks).toHaveLength(3);
    expect(trainTasks).toHaveLength(1);
  });

  test("fewer than 2 tasks or out-of-range fraction => no split", () => {
    expect(splitTasks([tasks[0] as SkillTask], 0.5).valTasks).toHaveLength(1);
    expect(splitTasks(tasks, 0).valTasks).toBe(tasks);
    expect(splitTasks(tasks, 1).valTasks).toBe(tasks);
  });
});

describe("trainSkill held-out validation", () => {
  const FM = "---\nname: demo\ndescription: d\n---\n";
  const ISO = () => "2026-05-29T00:00:00.000Z";

  test("scores candidates only on the held-out validation tasks", async () => {
    // Target always answers "VAL". Validation tasks expect "VAL" (score 1); training
    // tasks expect "TRAIN" (would score 0). With valFraction 0.5 the baseline reflects
    // only the val tasks -> 1.0, proving validation ignored the training tasks.
    const complete: CompleteFn = async () => ({
      text: "VAL",
      exit_code: 0,
      raw_stdout: "VAL",
      raw_stderr: "",
      duration_ms: 1,
    });
    const skill: Skill = {
      name: "demo",
      body: `${FM}body`,
      frontmatter: { name: "demo", description: "d" },
      tasks: [
        { id: "v1", prompt: "p", expected: "VAL" },
        { id: "v2", prompt: "p", expected: "VAL" },
        { id: "t1", prompt: "p", expected: "TRAIN" },
        { id: "t2", prompt: "p", expected: "TRAIN" },
      ],
    };

    const withSplit = await trainSkill({
      skill,
      complete,
      epochs: 1,
      batchSize: 2,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
      valFraction: 0.5,
      dryRun: true,
    });
    expect(withSplit.baselineScore).toBe(1); // only v1/v2 validated

    const noSplit = await trainSkill({
      skill,
      complete,
      epochs: 1,
      batchSize: 2,
      targetCli: "claude",
      optimizerCli: "claude",
      now: ISO,
      dryRun: true,
    });
    expect(noSplit.baselineScore).toBe(0.5); // all four validated (2 of 4 match)
  });
});
