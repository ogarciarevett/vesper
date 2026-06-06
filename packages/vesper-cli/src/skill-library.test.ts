import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLibrary } from "./skill-library.ts";

const SKILL_MD = `---
name: demo
description: A demo skill for the library test.
---

Do the thing well.
`;

const TASKS = JSON.stringify([
  { id: "t1", prompt: "say hi", expected: "hi", scorer: "contains" },
  { id: "t2", prompt: "say bye", expected: "bye" },
]);

describe("SkillLibrary", () => {
  let root: string;
  let skillsDir: string;
  let trainDir: string;
  let lib: SkillLibrary;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vesper-skilllib-"));
    skillsDir = join(root, "skills");
    trainDir = join(root, "train");
    mkdirSync(join(skillsDir, "demo"), { recursive: true });
    writeFileSync(join(skillsDir, "demo", "SKILL.md"), SKILL_MD);
    writeFileSync(join(skillsDir, "demo", "tasks.json"), TASKS);
    // A second skill with NO tasks.json (not trainable) and minimal frontmatter.
    mkdirSync(join(skillsDir, "plain"), { recursive: true });
    writeFileSync(
      join(skillsDir, "plain", "SKILL.md"),
      "---\nname: plain\ndescription: No harness.\n---\nbody",
    );
    lib = new SkillLibrary({ skillsDir, trainDir });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("list returns every skill with a SKILL.md, sorted, with task counts", async () => {
    const rows = await lib.list();
    expect(rows.map((r) => r.name)).toEqual(["demo", "plain"]);
    const demo = rows.find((r) => r.name === "demo");
    expect(demo).toMatchObject({
      displayName: "demo",
      taskCount: 2,
      hasCandidate: false,
      differs: false,
    });
    // A skill with no tasks.json reports taskCount null (not trainable).
    expect(rows.find((r) => r.name === "plain")?.taskCount).toBeNull();
  });

  test("a trained candidate that differs is flagged with its latest scores", async () => {
    // Seed a best.md + a history entry under the train dir.
    mkdirSync(join(trainDir, "demo"), { recursive: true });
    writeFileSync(join(trainDir, "demo", "best.md"), `${SKILL_MD}\nImproved.\n`);
    writeFileSync(
      join(trainDir, "demo", "history.jsonl"),
      `${JSON.stringify({ epoch: 1, priorBestScore: 0.5, candidateScore: 0.8, accepted: true, targetCli: "claude", optimizerCli: "claude", ts: "2026-06-06T00:00:00Z" })}\n`,
    );
    const demo = (await lib.list()).find((r) => r.name === "demo");
    expect(demo).toMatchObject({ hasCandidate: true, differs: true });
    expect(demo?.lastScore).toEqual({ prior: 0.5, candidate: 0.8, accepted: true });
  });

  test("get returns full detail: committed body, tasks, and the candidate", async () => {
    mkdirSync(join(trainDir, "demo"), { recursive: true });
    writeFileSync(join(trainDir, "demo", "best.md"), `${SKILL_MD}\nImproved.\n`);
    const d = await lib.get("demo");
    expect(d).not.toBeNull();
    expect(d?.body).toContain("Do the thing well.");
    expect(d?.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    // A task with no scorer defaults to "contains".
    expect(d?.tasks.find((t) => t.id === "t2")?.scorer).toBe("contains");
    expect(d?.best).toContain("Improved.");
  });

  test("get returns null for an unknown skill", async () => {
    expect(await lib.get("nope")).toBeNull();
  });

  test("get rejects a path-traversal name (throws via assertSkillName)", async () => {
    await expect(lib.get("../../etc")).rejects.toThrow();
  });

  test("list on a missing skills dir is empty, not an error", async () => {
    const empty = new SkillLibrary({ skillsDir: join(root, "does-not-exist"), trainDir });
    expect(await empty.list()).toEqual([]);
  });
});
