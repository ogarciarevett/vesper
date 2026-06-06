import { describe, expect, test } from "bun:test";
import { biomeCiPassed, bunTestPassed } from "./defaults.ts";

describe("bunTestPassed", () => {
  test("exit 0 is a pass", () => {
    expect(bunTestPassed({ exitCode: 0, stdout: "5 pass", stderr: "" })).toBe(true);
  });

  test("nonzero with the 'no test files' message is NOT a failure (nothing to run)", () => {
    const stderr = 'error: 0 test files matching **{.test,.spec}.{js,ts} in --cwd="/x"';
    expect(bunTestPassed({ exitCode: 1, stdout: "", stderr })).toBe(true);
  });

  test("detects the no-test marker on stdout too", () => {
    expect(bunTestPassed({ exitCode: 1, stdout: "0 test files matching", stderr: "" })).toBe(true);
  });

  test("a real test failure (nonzero, has failures) IS a failure", () => {
    expect(bunTestPassed({ exitCode: 1, stdout: "1 fail", stderr: "AssertionError" })).toBe(false);
  });
});

describe("biomeCiPassed", () => {
  test("exit 0 is a pass", () => {
    expect(biomeCiPassed({ exitCode: 0, stdout: "Checked 3 files", stderr: "" })).toBe(true);
  });

  test("nonzero with 'No files were processed' is NOT a failure (nothing to lint)", () => {
    const stdout =
      "Checked 0 files. No fixes applied.\n  No files were processed in the specified paths.";
    expect(biomeCiPassed({ exitCode: 1, stdout, stderr: "" })).toBe(true);
  });

  test("a real lint error IS a failure", () => {
    expect(biomeCiPassed({ exitCode: 1, stdout: "lint/style/noVar", stderr: "" })).toBe(false);
  });
});
