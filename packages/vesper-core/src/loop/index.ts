// @vesper/core — autonomous-loop engine (specs/autonomous-loop.md, DEV-113).
// LLM-authored self-prompting loops: the human sets the objective; per iteration
// the model AUTHORs the next prompt, EXECUTEs it, and a CRITIC judges the result.
// All three roles are `ctx.complete` CLI shell-outs (Hard rule 12) and the loop is
// hard-bounded (iterations, stalls, wall-clock).

export { runLoop } from "./engine.ts";
export { authorPrompt, criticPrompt, parseVerdict } from "./prompts.ts";
export {
  LOOP_DEFAULT_MAX_ITERATIONS,
  LOOP_DEFAULT_MAX_NO_PROGRESS,
  LOOP_MAX_ITERATIONS_CEILING,
  type LoopBounds,
  type LoopDeps,
  type LoopIteration,
  type LoopObjective,
  type LoopResult,
  type LoopRoles,
  type LoopSpec,
  type LoopStatus,
  type LoopVerdict,
} from "./types.ts";
