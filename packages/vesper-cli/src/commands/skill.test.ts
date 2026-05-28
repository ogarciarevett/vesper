import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../dispatch.ts";
import { registry } from "./index.ts";
import { projectCalls } from "./skill.ts";

let tempHome: string;
let skillsDir: string;
let originalVesperHome: string | undefined;

beforeEach(() => {
  tempHome = join(tmpdir(), `vesper-skill-test-${crypto.randomUUID()}`);
  skillsDir = join(tempHome, "skills");
  mkdirSync(skillsDir, { recursive: true });
  originalVesperHome = process.env.VESPER_HOME;
  process.env.VESPER_HOME = tempHome;
});

afterEach(() => {
  if (originalVesperHome !== undefined) process.env.VESPER_HOME = originalVesperHome;
  else delete process.env.VESPER_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

function makeSkill(name: string, taskCount: number): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `t${i}`,
    prompt: "p",
    expected: "e",
  }));
  writeFileSync(join(skillsDir, name, "tasks.json"), JSON.stringify(tasks));
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: intentional interception
  (process.stdout as any).write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore original
    (process.stdout as any).write = original;
  }
  return chunks.join("");
}

describe("projectCalls", () => {
  test("baseline N + epochs*(batch + 1 + N)", () => {
    // N=8, epochs=2, batch=4 -> 8 + 2*(4+1+8) = 34
    expect(projectCalls(8, 2, 4)).toBe(34);
  });

  test("batch is clamped to the task count", () => {
    // N=3, batch=10 -> batch clamps to 3: 3 + 1*(3+1+3) = 10
    expect(projectCalls(3, 1, 10)).toBe(10);
  });
});

describe("vesper skill list", () => {
  test("lists only directories that have a tasks.json", async () => {
    makeSkill("alpha", 5);
    mkdirSync(join(skillsDir, "no-harness"), { recursive: true }); // no tasks.json
    const out = await captureStdout(() =>
      dispatch(registry, ["skill", "list", "--skills-dir", skillsDir]),
    );
    expect(out).toContain("alpha");
    expect(out).toContain("5");
    expect(out).not.toContain("no-harness");
  });

  test("reports when there are no trainable skills", async () => {
    const out = await captureStdout(() =>
      dispatch(registry, ["skill", "list", "--skills-dir", skillsDir]),
    );
    expect(out).toContain("no trainable skills");
  });
});

describe("vesper skill diff", () => {
  test("reports when no trained candidate exists yet", async () => {
    makeSkill("alpha", 2);
    const out = await captureStdout(() =>
      dispatch(registry, ["skill", "diff", "alpha", "--skills-dir", skillsDir]),
    );
    expect(out).toContain("no trained candidate");
  });
});
