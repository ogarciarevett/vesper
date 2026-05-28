import { describe, expect, test } from "bun:test";
import { SkillTrainError } from "./errors.ts";
import { parseFrontmatter } from "./frontmatter.ts";

const VALID = `---
name: test-driven-development
description: Drives development with tests. Use when implementing logic.
---

# Body
`;

describe("parseFrontmatter", () => {
  test("extracts name and description", () => {
    const fm = parseFrontmatter(VALID);
    expect(fm.name).toBe("test-driven-development");
    expect(fm.description).toBe("Drives development with tests. Use when implementing logic.");
  });

  test("strips surrounding quotes", () => {
    const fm = parseFrontmatter(`---\nname: "quoted"\ndescription: 'single'\n---\n`);
    expect(fm.name).toBe("quoted");
    expect(fm.description).toBe("single");
  });

  test("tolerates CRLF line endings", () => {
    const fm = parseFrontmatter("---\r\nname: x\r\ndescription: y\r\n---\r\n");
    expect(fm.name).toBe("x");
    expect(fm.description).toBe("y");
  });

  test("throws when frontmatter block is absent", () => {
    expect(() => parseFrontmatter("# no frontmatter")).toThrow(SkillTrainError);
  });

  test("throws when a required field is missing", () => {
    expect(() => parseFrontmatter("---\nname: only-name\n---\n")).toThrow(SkillTrainError);
  });

  test("throws when a field is empty", () => {
    expect(() => parseFrontmatter("---\nname:\ndescription: d\n---\n")).toThrow(SkillTrainError);
  });
});
