/**
 * The `selftest` pipeline — Vesper's first pipeline and the end-to-end validator
 * for the pipeline runtime path. (Renamed from `echo`; the name "echo" now refers
 * to the live agent-presence feature in Vesper World.)
 *
 * It is deliberately the smallest possible non-UI pipeline: a manual task that
 * sends a prompt through the user's resolved CLI adapter (`ctx.complete`) and
 * records the run (`ctx.recordRun`). The handler is CLI-agnostic — the LLM is
 * decided per request by the runtime (run-override -> configured default), not
 * bound to the task. This proves the bring-your-own-CLI direction and establishes
 * the runtime contract every later pipeline inherits.
 *
 * Capabilities: `CLI_INVOKE` (to call the adapter) and `WRITE_STORAGE` (to write
 * the `runs` row). Both are asserted at the context boundary before any side effect.
 */

import type { RegisterTaskInput, TaskHandler } from "@vesper/core";

/** Allowlisted handler id referenced by the `selftest` task. */
export const SELFTEST_HANDLER_ID = "selftest";

/** Maximum length of the persisted run summary. */
const SUMMARY_MAX_LENGTH = 500;

/**
 * Default self-test prompt used when no `prompt` param is supplied. Asks the CLI
 * to confirm it received the Vesper self-test pipeline and to name itself.
 */
const DEFAULT_PROMPT =
  "You are being invoked by the Vesper self-test pipeline as a runtime self-test — " +
  "reply in one sentence confirming you received this and stating which CLI you are.";

/**
 * Resolve the prompt for this run: the `prompt` param when it is a non-empty
 * string, otherwise the fixed default self-test prompt.
 */
function resolvePrompt(params: Readonly<Record<string, unknown>>): string {
  const raw = params.prompt;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }
  return DEFAULT_PROMPT;
}

/**
 * Self-test pipeline handler. Resolves the prompt, sends it through the CLI
 * adapter the runtime selected for this request, and records the run.
 *
 * A zero-exit completion with empty output is recorded as `error`: for a
 * self-test, an empty response is a failed check, not a success. (The adapter
 * already throws on a non-zero exit, so that path surfaces before `recordRun`.)
 */
export const selftestHandler: TaskHandler = async (ctx) => {
  const prompt = resolvePrompt(ctx.params);
  const result = await ctx.complete(prompt);
  const text = result.text.trim().slice(0, SUMMARY_MAX_LENGTH);
  if (result.exit_code === 0 && text.length > 0) {
    ctx.recordRun({ status: "ok", summary: text });
  } else {
    ctx.recordRun({ status: "error", summary: text.length > 0 ? text : "(empty response)" });
  }
};

/**
 * Manual task wiring for the `selftest` pipeline. `max_duration_ms` declares an
 * explicit wall-clock guardrail at the task layer (defense-in-depth above the
 * adapter's own process timeout).
 */
export const selftestTaskInput: RegisterTaskInput = {
  id: "selftest",
  kind: "manual",
  schedule_expr: "",
  handler_id: SELFTEST_HANDLER_ID,
  max_duration_ms: 60_000,
  required_capabilities: ["CLI_INVOKE", "WRITE_STORAGE"],
};
