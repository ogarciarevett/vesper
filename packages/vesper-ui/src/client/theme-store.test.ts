import { describe, expect, test } from "bun:test";
import { pickThemeId, readUrlTheme } from "./theme-store.ts";

describe("readUrlTheme", () => {
  test("extracts ?theme=", () => {
    expect(readUrlTheme("?theme=cyberpunk")).toBe("cyberpunk");
    expect(readUrlTheme("?foo=1&theme=hearth")).toBe("hearth");
  });

  test("returns null when absent", () => {
    expect(readUrlTheme("")).toBeNull();
    expect(readUrlTheme("?foo=1")).toBeNull();
  });
});

describe("pickThemeId precedence (url > stored > serverDefault > null)", () => {
  test("explicit URL theme wins over everything", () => {
    expect(pickThemeId({ url: "cyberpunk", stored: "hearth", serverDefault: "hearth" })).toBe(
      "cyberpunk",
    );
  });

  test("stored choice wins when no URL theme", () => {
    expect(pickThemeId({ url: null, stored: "cyberpunk", serverDefault: "hearth" })).toBe(
      "cyberpunk",
    );
  });

  test("server default applies when nothing else is set", () => {
    expect(pickThemeId({ url: null, stored: null, serverDefault: "hearth" })).toBe("hearth");
  });

  test("null when nothing is set (registry default takes over)", () => {
    expect(pickThemeId({ url: null, stored: null, serverDefault: null })).toBeNull();
  });
});
