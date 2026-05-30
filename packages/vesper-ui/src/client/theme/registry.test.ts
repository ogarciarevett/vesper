import { describe, expect, test } from "bun:test";
import { listThemes, registerTheme, resolveTheme } from "./registry.ts";
import type { WorldTheme } from "./types.ts";

// Stub themes — drawScene is never invoked here, just registered/resolved.
const stub = (id: string): WorldTheme => ({ id, displayName: id, drawScene: () => [] });

describe("theme registry", () => {
  test("first registered theme becomes the default; resolveTheme(null) returns it", () => {
    registerTheme(stub("alpha"));
    registerTheme(stub("beta"));
    expect(resolveTheme(null).id).toBe("alpha");
  });

  test("an explicit default: true overrides the first-registered default", () => {
    registerTheme(stub("gamma"), { default: true });
    expect(resolveTheme(null).id).toBe("gamma");
  });

  test("a valid requested id wins", () => {
    expect(resolveTheme("beta").id).toBe("beta");
  });

  test("an unknown requested id falls back to the default (never throws)", () => {
    expect(resolveTheme("does-not-exist").id).toBe("gamma");
  });

  test("listThemes returns every registered theme", () => {
    expect(listThemes().map((t) => t.id)).toEqual(
      expect.arrayContaining(["alpha", "beta", "gamma"]),
    );
  });
});
