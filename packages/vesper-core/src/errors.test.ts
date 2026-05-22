import { describe, expect, test } from "bun:test";
import { VesperError } from "./errors.ts";

describe("VesperError", () => {
  test("carries code and message and is an Error", () => {
    const err = new VesperError("vault", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("vault");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("VesperError");
  });

  test("name reflects the most-derived subclass", () => {
    class SubError extends VesperError {}
    expect(new SubError("x", "y").name).toBe("SubError");
  });

  test("preserves the underlying cause", () => {
    const cause = new Error("root");
    expect(new VesperError("cli", "wrap", { cause }).cause).toBe(cause);
  });
});
