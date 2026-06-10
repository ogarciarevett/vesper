import { describe, expect, it } from "bun:test";
import { contextMeta } from "./model-picker.ts";

describe("contextMeta", () => {
  it("formats million-token windows compactly", () => {
    expect(contextMeta(1_000_000)).toBe("1M ctx");
    expect(contextMeta(1_048_576)).toBe("1M ctx");
    expect(contextMeta(1_050_000)).toBe("1.1M ctx");
  });

  it("formats sub-million windows in K", () => {
    expect(contextMeta(400_000)).toBe("400K ctx");
    expect(contextMeta(272_000)).toBe("272K ctx");
  });

  it("passes unknown through as undefined (no meta line)", () => {
    expect(contextMeta(undefined)).toBeUndefined();
  });
});
