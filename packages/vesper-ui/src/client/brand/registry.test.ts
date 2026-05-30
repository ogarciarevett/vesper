import { describe, expect, test } from "bun:test";
import "./builtins.ts"; // self-registers the built-in marks
import { listMarks, resolveMark } from "./registry.ts";

describe("brand registry resolveMark", () => {
  test("resolves a live presence id (presence:<matcher>) to its brand", () => {
    expect(resolveMark("presence:claude-cli").id).toBe("claude");
    expect(resolveMark("presence:claude-app").id).toBe("claude");
    expect(resolveMark("presence:codex-cli").id).toBe("codex");
    expect(resolveMark("presence:gemini-cli").id).toBe("gemini");
    expect(resolveMark("presence:opencode-cli").id).toBe("opencode");
  });

  test("distinguishes zeroclaw from ironclaw (no substring collision)", () => {
    expect(resolveMark("presence:zeroclaw-cli").id).toBe("zeroclaw");
    expect(resolveMark("ironclaw").id).toBe("ironclaw");
    expect(resolveMark("hermes").id).toBe("hermes");
  });

  test("resolves a bare brand id exactly", () => {
    expect(resolveMark("claude").id).toBe("claude");
    expect(resolveMark("codex").id).toBe("codex");
  });

  test("NEVER returns null — an unknown agent falls back to the Vesper default mark", () => {
    expect(resolveMark("skill-train").id).toBe("vesper");
    expect(resolveMark("presence:totally-unknown").id).toBe("vesper");
    expect(resolveMark("").id).toBe("vesper");
  });

  test("every mark exposes an id, a label, a color, and a draw fn", () => {
    for (const mark of listMarks()) {
      expect(typeof mark.id).toBe("string");
      expect(mark.label.length).toBeGreaterThan(0);
      expect(mark.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(typeof mark.draw).toBe("function");
    }
  });
});
