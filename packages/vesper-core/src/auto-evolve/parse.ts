/**
 * The auto-evolve report parser — extracts the fenced-JSON closed shape from the
 * reflection model's raw reply. Modeled on `skill-train`'s `parseCandidate` but
 * FAIL-CLOSED: it never throws. A malformed reply yields a typed error so the
 * handler can record the run as `no_change` and write nothing. Never uses `eval` —
 * only `JSON.parse` on the extracted fence.
 */

import type { EvolveReport, FixProposal, SkillProposal } from "./types.ts";

/** Discriminated result of {@link parseEvolveReport}. */
export type ParseResult =
  | { readonly ok: true; readonly report: EvolveReport }
  | { readonly ok: false; readonly error: string };

/** Match the inner content of the FIRST fenced code block (optional language tag). */
const FENCE_RE = /```[^\n`]*\r?\n([\s\S]*?)\r?\n```/;

/** Narrow `value` to a plain object record (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only well-formed `{ name, reason }` skill proposals; drop the rest. */
function parseSkillProposals(raw: unknown): SkillProposal[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillProposal[] = [];
  for (const item of raw) {
    if (isRecord(item) && typeof item.name === "string" && typeof item.reason === "string") {
      out.push({ name: item.name, reason: item.reason });
    }
  }
  return out;
}

/** Keep only well-formed `{ signature, rootCause, proposedFix }` fix proposals; drop the rest. */
function parseFixProposals(raw: unknown): FixProposal[] {
  if (!Array.isArray(raw)) return [];
  const out: FixProposal[] = [];
  for (const item of raw) {
    if (
      isRecord(item) &&
      typeof item.signature === "string" &&
      typeof item.rootCause === "string" &&
      typeof item.proposedFix === "string"
    ) {
      out.push({
        signature: item.signature,
        rootCause: item.rootCause,
        proposedFix: item.proposedFix,
      });
    }
  }
  return out;
}

/**
 * Extract + validate the reflection report. Returns `{ ok: true, report }` on a
 * valid fenced-JSON object with a string `summary`; otherwise `{ ok: false, error }`.
 * Malformed proposal entries are dropped (not fatal); a missing/empty `summary` IS
 * fatal (the report carries no signal).
 */
export function parseEvolveReport(text: string): ParseResult {
  const fenced = FENCE_RE.exec(text);
  if (fenced?.[1] === undefined) {
    return { ok: false, error: "no fenced ```json block found in the reflection reply" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1].trim());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `fenced block was not valid JSON: ${message}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "reflection JSON must be an object" };
  }
  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
    return { ok: false, error: "reflection JSON is missing a non-empty `summary`" };
  }

  return {
    ok: true,
    report: {
      summary: parsed.summary,
      skillProposals: parseSkillProposals(parsed.skillProposals),
      fixProposals: parseFixProposals(parsed.fixProposals),
    },
  };
}
