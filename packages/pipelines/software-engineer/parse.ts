/**
 * Brain-output parsers for the software-engineer pipeline.
 *
 * Both parseSpec and parsePlan are fail-closed: they never throw, and a
 * malformed reply yields a typed error so the caller can record the failure
 * and write nothing. They never use eval — only JSON.parse on extracted
 * fenced blocks. Modeled on vesper-core/src/auto-evolve/parse.ts.
 */

/** Discriminated result wrapper, generic over the success payload. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** A parsed feature specification produced by the brain. */
export interface SpecDoc {
  readonly title: string;
  readonly body: string;
}

/** A single task within a build plan. */
export interface PlannedTask {
  readonly id: string;
  readonly files: readonly string[];
  readonly instruction: string;
}

/** A build plan as a sequence of ordered tasks. */
export interface BuildPlan {
  readonly tasks: readonly PlannedTask[];
}

/** Match the inner content of the FIRST fenced code block (optional language tag). */
const FENCE_RE = /```[^\n`]*\r?\n([\s\S]*?)\r?\n```/;

/** Narrow value to a plain object record (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the first fenced JSON block and parse it as a SpecDoc.
 *
 * Returns `{ ok: true, value: { title, body } }` when the block contains a
 * valid JSON object with non-empty string `title` and `body` (both trimmed).
 * Missing or empty fields are fatal — returns `{ ok: false, error }`.
 */
export function parseSpec(text: string): ParseResult<SpecDoc> {
  const fenced = FENCE_RE.exec(text);
  if (fenced?.[1] === undefined) {
    return { ok: false, error: "no fenced ```json block found in the reply" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1].trim());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `fenced block was not valid JSON: ${message}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "spec JSON must be an object" };
  }

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";

  if (title.length === 0) {
    return { ok: false, error: "spec JSON is missing a non-empty `title`" };
  }
  if (body.length === 0) {
    return { ok: false, error: "spec JSON is missing a non-empty `body`" };
  }

  return { ok: true, value: { title, body } };
}

/** Keep only well-formed `{ id, files, instruction }` task entries; drop the rest. */
function parsePlannedTasks(raw: unknown): PlannedTask[] {
  if (!Array.isArray(raw)) return [];
  const out: PlannedTask[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;

    const id = typeof item.id === "string" ? item.id.trim() : "";
    const instruction = typeof item.instruction === "string" ? item.instruction.trim() : "";
    if (id.length === 0 || instruction.length === 0) continue;

    if (!Array.isArray(item.files)) continue;

    // Keep only non-empty string file paths; trim each.
    const files: string[] = [];
    for (const f of item.files) {
      if (typeof f === "string" && f.trim().length > 0) {
        files.push(f.trim());
      }
    }
    // A task with no valid file paths is dropped.
    if (files.length === 0) continue;

    out.push({ id, files, instruction });
  }
  return out;
}

/**
 * Extract the first fenced JSON block and parse it as a BuildPlan.
 *
 * Returns `{ ok: true, value: { tasks } }` on success. Malformed task entries
 * are silently dropped (not fatal). Zero valid tasks remaining IS fatal and
 * returns `{ ok: false, error: "no valid tasks" }`.
 */
export function parsePlan(text: string): ParseResult<BuildPlan> {
  const fenced = FENCE_RE.exec(text);
  if (fenced?.[1] === undefined) {
    return { ok: false, error: "no fenced ```json block found in the reply" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1].trim());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `fenced block was not valid JSON: ${message}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "plan JSON must be an object" };
  }

  const tasks = parsePlannedTasks(parsed.tasks);
  if (tasks.length === 0) {
    return { ok: false, error: "no valid tasks" };
  }

  return { ok: true, value: { tasks } };
}
