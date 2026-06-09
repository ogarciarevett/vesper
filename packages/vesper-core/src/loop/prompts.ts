/**
 * The three loop meta-prompts + the fail-closed critic-verdict parser.
 *
 * These are deliberately the LAST hand-written prompts in the loop: AUTHOR's
 * meta-prompt asks the model to write the next operational prompt itself, so every
 * downstream prompt is model-authored. The critic replies in a fenced JSON block
 * (the `auto-evolve`/`software-engineer` parse idiom); a malformed verdict is
 * treated as NO progress, never as success.
 */

import type { LoopIteration, LoopObjective, LoopVerdict } from "./types.ts";

/** Cap on transcript text quoted back into the AUTHOR prompt, per field. */
const TRANSCRIPT_FIELD_MAX = 700;

/** Match the inner content of the FIRST fenced code block (optional language tag). */
const FENCE_RE = /```[^\n`]*\r?\n([\s\S]*?)\r?\n```/;

/** Truncate one transcript field so a verbose iteration cannot blow up the next prompt. */
function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TRANSCRIPT_FIELD_MAX
    ? `${trimmed.slice(0, TRANSCRIPT_FIELD_MAX)} [...]`
    : trimmed;
}

/** Render the objective block shared by AUTHOR and CRITIC. */
function objectiveBlock(objective: LoopObjective): string {
  const criteria =
    objective.successCriteria !== undefined
      ? `\nSuccess criteria: ${objective.successCriteria}`
      : "";
  return `Objective: ${objective.goal}${criteria}`;
}

/**
 * The AUTHOR meta-prompt — the load-bearing idea: given the objective and what
 * already happened, the model writes the single best next prompt itself.
 */
export function authorPrompt(
  objective: LoopObjective,
  transcript: readonly LoopIteration[],
): string {
  const history =
    transcript.length === 0
      ? "(no iterations yet — this is the first turn)"
      : transcript
          .map(
            (it) =>
              `Iteration ${it.index}:\n` +
              `- prompt: ${clip(it.authoredPrompt)}\n` +
              `- result: ${clip(it.executionSummary)}\n` +
              `- critic: progress ${it.verdict.progress}/100 — ${clip(it.verdict.feedback)}`,
          )
          .join("\n\n");

  return (
    "You are directing an autonomous reasoning loop toward an objective. " +
    "You write the prompts; another model run executes them.\n\n" +
    `${objectiveBlock(objective)}\n\n` +
    `Transcript so far:\n${history}\n\n` +
    "Write the single best next prompt to make progress toward the objective. " +
    "Take the critic feedback into account. Output ONLY the prompt text — " +
    "no preamble, no commentary, no code fences."
  );
}

/** The CRITIC meta-prompt — judge one execution result against the objective. */
export function criticPrompt(
  objective: LoopObjective,
  authoredPrompt: string,
  executionResult: string,
): string {
  return (
    "You are the critic of an autonomous reasoning loop. Judge the latest result " +
    "against the objective.\n\n" +
    `${objectiveBlock(objective)}\n\n` +
    `Prompt that was executed:\n${clip(authoredPrompt)}\n\n` +
    `Execution result:\n${clip(executionResult)}\n\n` +
    "Reply with ONLY a fenced JSON block of this exact shape:\n" +
    '```json\n{ "done": false, "progress": 0, "feedback": "..." }\n```\n' +
    '- "done": true ONLY if the objective is fully met by the result.\n' +
    '- "progress": integer 0-100, overall progress toward the objective.\n' +
    '- "feedback": one or two sentences directing the next prompt.'
  );
}

/** Clamp a parsed progress value into 0-100; non-finite input falls back to `prev`. */
function clampProgress(raw: unknown, prev: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return prev;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * Parse the critic's reply FAIL-CLOSED. Accepts a fenced JSON block (preferred)
 * or a bare JSON object. Anything malformed yields
 * `{ done: false, progress: prevProgress, feedback: "unparseable critic verdict" }`
 * — a bad critic stalls the loop, it never falsely succeeds it.
 */
export function parseVerdict(text: string, prevProgress: number): LoopVerdict {
  const fenced = FENCE_RE.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { done: false, progress: prevProgress, feedback: "unparseable critic verdict" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { done: false, progress: prevProgress, feedback: "unparseable critic verdict" };
  }

  const record = parsed as Record<string, unknown>;
  return {
    done: record.done === true,
    progress: clampProgress(record.progress, prevProgress),
    feedback: typeof record.feedback === "string" ? record.feedback : "",
  };
}
