import { describe, expect, test } from "bun:test";
import { ALL_SECTIONS } from "./index.ts";

// The browser client is bundled by Bun (which does NOT error on an undefined
// identifier) and is outside the root tsc program, so a section referenced in the
// barrel but never imported only fails at runtime in the browser. This test imports
// the barrel and builds ALL_SECTIONS — exactly what the shell does on boot — so a
// missing/renamed section export is caught in CI instead.
describe("ALL_SECTIONS", () => {
  test("registers every section with a unique id (catches a missing import)", () => {
    expect(ALL_SECTIONS).toHaveLength(13);
    const ids = ALL_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("each section has a valid SectionModule shape", () => {
    for (const s of ALL_SECTIONS) {
      expect(typeof s.id).toBe("string");
      expect(s.title.length).toBeGreaterThan(0);
      expect(["primary", "vesper", "computer"]).toContain(s.group);
      expect(s.glyph.length).toBeGreaterThan(0);
      expect(typeof s.mount).toBe("function");
    }
  });
});
