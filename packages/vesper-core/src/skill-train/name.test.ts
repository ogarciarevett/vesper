import { describe, expect, test } from "bun:test";
import { SkillTrainError } from "./errors.ts";
import { assertSkillName } from "./name.ts";

describe("assertSkillName", () => {
  test("accepts plain slugs", () => {
    expect(() => assertSkillName("test-driven-development")).not.toThrow();
    expect(() => assertSkillName("code_review")).not.toThrow();
    expect(() => assertSkillName("a1")).not.toThrow();
  });

  test.each([
    "../etc",
    "../../secrets",
    "a/b",
    "a\\b",
    ".hidden",
    "",
    "with space",
    "-leading-dash",
  ])("rejects path-unsafe name %p", (name) => {
    expect(() => assertSkillName(name)).toThrow(SkillTrainError);
  });
});
