/**
 * Tests for `buildReflectPrompt` (reflect.ts) and `parseEvolveReport` (parse.ts).
 *
 * - The prompt frames the digest as UNTRUSTED data and is length-bounded.
 * - The parser extracts a fenced-JSON closed shape and NEVER throws — it returns a
 *   typed error (the fail-closed posture). It never uses `eval`.
 */

import { describe, expect, test } from "bun:test";
import { parseEvolveReport } from "./parse.ts";
import { buildReflectPrompt } from "./reflect.ts";

// ---------------------------------------------------------------------------
// buildReflectPrompt
// ---------------------------------------------------------------------------

describe("buildReflectPrompt", () => {
  test("frames the digest as untrusted data", () => {
    const prompt = buildReflectPrompt("## roll-up\n- a: 1 runs, 1 errors");
    expect(prompt.toLowerCase()).toContain("untrusted");
    expect(prompt).toContain("- a: 1 runs, 1 errors");
  });

  test("is deterministic for the same digest", () => {
    const a = buildReflectPrompt("d");
    const b = buildReflectPrompt("d");
    expect(a).toBe(b);
  });

  test("length-caps an oversized digest", () => {
    const huge = "x".repeat(50_000);
    const prompt = buildReflectPrompt(huge);
    // The prompt must not balloon to the full 50k of digest.
    expect(prompt.length).toBeLessThan(20_000);
  });

  test("asks for the closed JSON shape (summary, skillProposals, fixProposals)", () => {
    const prompt = buildReflectPrompt("d");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("skillProposals");
    expect(prompt).toContain("fixProposals");
    expect(prompt).toContain("```json");
  });
});

// ---------------------------------------------------------------------------
// parseEvolveReport — success
// ---------------------------------------------------------------------------

describe("parseEvolveReport success", () => {
  test("extracts a fenced-json report with all three fields", () => {
    const text = [
      "Here is my analysis.",
      "```json",
      JSON.stringify({
        summary: "two pipelines failing",
        skillProposals: [{ name: "web-search", reason: "fetch fails need a search skill" }],
        fixProposals: [
          { signature: "ENOENT", rootCause: "missing dir", proposedFix: "mkdir -p first" },
        ],
      }),
      "```",
      "trailing prose",
    ].join("\n");

    const result = parseEvolveReport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.report.summary).toBe("two pipelines failing");
    expect(result.report.skillProposals).toEqual([
      { name: "web-search", reason: "fetch fails need a search skill" },
    ]);
    expect(result.report.fixProposals).toHaveLength(1);
    expect(result.report.fixProposals[0]?.signature).toBe("ENOENT");
  });

  test("defaults empty proposal arrays when omitted", () => {
    const text = ["```json", JSON.stringify({ summary: "all healthy" }), "```"].join("\n");
    const result = parseEvolveReport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.report.skillProposals).toEqual([]);
    expect(result.report.fixProposals).toEqual([]);
  });

  test("drops malformed proposal entries rather than failing the whole parse", () => {
    const text = [
      "```json",
      JSON.stringify({
        summary: "s",
        skillProposals: [{ name: "ok-skill", reason: "r" }, { name: 42 }, { reason: "no name" }],
        fixProposals: [{ signature: "x" }],
      }),
      "```",
    ].join("\n");
    const result = parseEvolveReport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.report.skillProposals).toEqual([{ name: "ok-skill", reason: "r" }]);
    // A fix proposal missing rootCause/proposedFix is dropped.
    expect(result.report.fixProposals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseEvolveReport — fail-closed (never throws)
// ---------------------------------------------------------------------------

describe("parseEvolveReport fail-closed", () => {
  test("returns an error (does not throw) when there is no fenced block", () => {
    const result = parseEvolveReport("just some prose, no json here");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error).toBeTruthy();
  });

  test("returns an error when the fenced block is not valid JSON", () => {
    const result = parseEvolveReport("```json\n{not valid}\n```");
    expect(result.ok).toBe(false);
  });

  test("returns an error when summary is missing", () => {
    const result = parseEvolveReport(
      `\`\`\`json\n${JSON.stringify({ skillProposals: [] })}\n\`\`\``,
    );
    expect(result.ok).toBe(false);
  });

  test("returns an error when the JSON is an array, not an object", () => {
    const result = parseEvolveReport("```json\n[1,2,3]\n```");
    expect(result.ok).toBe(false);
  });
});
