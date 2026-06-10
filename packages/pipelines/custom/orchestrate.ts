/**
 * The custom-pipeline mastermind (specs/pipeline-editor.md): between stages, one
 * orchestrator completion reviews the prior stage's outcomes and REWRITES the next
 * stage's task prompts — the Vesper-authors-every-prompt pattern from
 * orchestrator-home, applied to user-authored pipelines. Parsing is fail-soft:
 * a malformed revision keeps the original prompts (never stalls the run).
 */

import type { PipelineDoc, PipelineDocStep } from "./doc.ts";

/** One finished task the orchestrator reasons over. */
export interface StageOutcome {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string;
}

/** Match the inner content of the FIRST fenced code block (optional language tag). */
const FENCE_RE = /```[^\n`]*\r?\n([\s\S]*?)\r?\n```/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build the between-stages revision prompt for the orchestrator model. */
export function buildOrchestratorRevisionPrompt(
  doc: PipelineDoc,
  nextTasks: readonly PipelineDocStep[],
  prior: readonly StageOutcome[],
): string {
  return [
    `You are Vesper, orchestrating the user's pipeline "${doc.name}"` +
      `${doc.description.length > 0 ? ` (${doc.description})` : ""}.`,
    "The previous stage finished. Re-author the next stage's prompts so they BUILD ON",
    "the results below. Keep each task's intent; improve focus and formatting.",
    ...(doc.orchestrator.instructions !== undefined
      ? ["", "Standing instructions from the pipeline author:", doc.orchestrator.instructions]
      : []),
    "",
    "Previous stage results:",
    ...prior.map((o) => `- [${o.status}] ${o.title} (${o.id}): ${o.summary.slice(0, 400)}`),
    "",
    "Next stage tasks (keep the same ids; rewrite only the prompts):",
    ...nextTasks.map((t) => `- ${t.id} (${t.title}): ${t.prompt.slice(0, 400)}`),
    "",
    'Reply with ONLY a fenced JSON array: [{ "id": "...", "prompt": "..." }, ...]',
  ].join("\n");
}

/** Parse the revision reply; returns id->prompt, or null to keep the originals. */
export function parseOrchestratorRevision(text: string): Readonly<Record<string, string>> | null {
  const fenced = FENCE_RE.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : null;
    const prompt =
      typeof item.prompt === "string" && item.prompt.trim().length > 0 ? item.prompt.trim() : null;
    if (id !== null && prompt !== null) out[id] = prompt;
  }
  return Object.keys(out).length > 0 ? out : null;
}
