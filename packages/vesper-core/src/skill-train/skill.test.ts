import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SkillTrainError } from "./errors.ts";
import { type LoadSkillOptions, loadSkill } from "./skill.ts";

const SKILLS_DIR = ".ai/skills";

const VALID_SKILL_MD = `---
name: greeter
description: Greets people warmly. Use when a greeting is needed.
---

# Greeter

Say hello to the user by name.
`;

/** Build a fake file backend over an in-memory map — no real filesystem. */
function fakeBackend(files: Record<string, string>): Pick<LoadSkillOptions, "readFile" | "exists"> {
  const store = new Map<string, string>(Object.entries(files));
  return {
    exists: (path: string) => Promise.resolve(store.has(path)),
    readFile: (path: string) => {
      const value = store.get(path);
      if (value === undefined) {
        return Promise.reject(new Error(`unexpected read: ${path}`));
      }
      return Promise.resolve(value);
    },
  };
}

function skillPath(name: string): string {
  return join(SKILLS_DIR, name, "SKILL.md");
}

function tasksPath(name: string): string {
  return join(SKILLS_DIR, name, "tasks.json");
}

describe("loadSkill", () => {
  it("loads a valid skill with frontmatter, full body, and tasks", async () => {
    const tasksJson = JSON.stringify([
      { id: "t1", prompt: "Greet Omar", expected: "Hello Omar", scorer: "contains" },
      { id: "t2", prompt: "Greet Ada", expected: "Hello Ada" },
    ]);
    const backend = fakeBackend({
      [skillPath("greeter")]: VALID_SKILL_MD,
      [tasksPath("greeter")]: tasksJson,
    });

    const skill = await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });

    expect(skill.name).toBe("greeter");
    expect(skill.body).toBe(VALID_SKILL_MD);
    expect(skill.frontmatter).toEqual({
      name: "greeter",
      description: "Greets people warmly. Use when a greeting is needed.",
    });
    expect(skill.tasks).toEqual([
      { id: "t1", prompt: "Greet Omar", expected: "Hello Omar", scorer: "contains" },
      { id: "t2", prompt: "Greet Ada", expected: "Hello Ada" },
    ]);
  });

  it("omits the scorer field entirely when a task does not specify one", async () => {
    const backend = fakeBackend({
      [skillPath("greeter")]: VALID_SKILL_MD,
      [tasksPath("greeter")]: JSON.stringify([{ id: "t1", prompt: "p", expected: "e" }]),
    });

    const skill = await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });

    const [task] = skill.tasks;
    expect(task).toBeDefined();
    expect("scorer" in (task as object)).toBe(false);
  });

  it("throws skill_not_found when SKILL.md is absent", async () => {
    const backend = fakeBackend({});

    try {
      await loadSkill("ghost", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("skill_not_found");
    }
  });

  it("throws no_tasks when tasks.json is absent", async () => {
    const backend = fakeBackend({ [skillPath("greeter")]: VALID_SKILL_MD });

    try {
      await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("no_tasks");
    }
  });

  it("throws no_tasks when tasks.json is an empty array", async () => {
    const backend = fakeBackend({
      [skillPath("greeter")]: VALID_SKILL_MD,
      [tasksPath("greeter")]: "[]",
    });

    try {
      await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("no_tasks");
    }
  });

  it("throws invalid_tasks when tasks.json is not an array", async () => {
    const backend = fakeBackend({
      [skillPath("greeter")]: VALID_SKILL_MD,
      [tasksPath("greeter")]: JSON.stringify({ id: "t1", prompt: "p", expected: "e" }),
    });

    try {
      await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("invalid_tasks");
    }
  });

  it("throws invalid_tasks when tasks.json is malformed JSON", async () => {
    const backend = fakeBackend({
      [skillPath("greeter")]: VALID_SKILL_MD,
      [tasksPath("greeter")]: "[{ not valid json",
    });

    try {
      await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("invalid_tasks");
    }
  });

  it("throws invalid_tasks when a task is missing its prompt", async () => {
    const backend = fakeBackend({
      [skillPath("greeter")]: VALID_SKILL_MD,
      [tasksPath("greeter")]: JSON.stringify([{ id: "t1", expected: "e" }]),
    });

    try {
      await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("invalid_tasks");
    }
  });

  it("throws invalid_tasks when a task expected is not a string", async () => {
    const backend = fakeBackend({
      [skillPath("greeter")]: VALID_SKILL_MD,
      [tasksPath("greeter")]: JSON.stringify([{ id: "t1", prompt: "p", expected: 42 }]),
    });

    try {
      await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("invalid_tasks");
    }
  });

  it("throws invalid_tasks when a task has an unknown scorer", async () => {
    const backend = fakeBackend({
      [skillPath("greeter")]: VALID_SKILL_MD,
      [tasksPath("greeter")]: JSON.stringify([
        { id: "t1", prompt: "p", expected: "e", scorer: "fuzzy" },
      ]),
    });

    try {
      await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("invalid_tasks");
    }
  });

  it("propagates invalid_skill when SKILL.md has no frontmatter", async () => {
    const backend = fakeBackend({
      [skillPath("greeter")]: "# Greeter\n\nNo frontmatter here.\n",
      [tasksPath("greeter")]: JSON.stringify([{ id: "t1", prompt: "p", expected: "e" }]),
    });

    try {
      await loadSkill("greeter", { skillsDir: SKILLS_DIR, ...backend });
      throw new Error("expected loadSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillTrainError);
      expect((error as SkillTrainError).reason).toBe("invalid_skill");
    }
  });
});
