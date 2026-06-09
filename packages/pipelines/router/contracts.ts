/**
 * Orchestration contracts (`specs/orchestrator-home.md`, slice F).
 *
 * A contract is what a pipeline DECLARES about being orchestrated: which params a
 * plan may set, where the Vesper-authored prompt is delivered, how many parallel
 * instances are allowed, whether it accepts a model override, and whether it
 * spawns its own children (which forces sibling-run execution — depth-1 rule).
 * The planner can only reference contract keys — handler ids NEVER come from
 * model text — and whatever a contract declares is respected unconditionally
 * (the validator clamps; Vesper decides only where a contract is silent).
 */

import type { Capability } from "@vesper/core";
import { LOOP_HANDLER_ID, loopTaskInput } from "../loop/handler.ts";
import { SELFTEST_HANDLER_ID, selftestTaskInput } from "../selftest/handler.ts";
import {
  SOFTWARE_ENGINEER_HANDLER_ID,
  softwareEngineerTaskInput,
} from "../software-engineer/index.ts";

/** What one pipeline declares about being driven by an orchestration plan. */
export interface OrchestrationContract {
  readonly handlerId: string;
  /** One-line description injected into the planning prompt. */
  readonly summary: string;
  /** The ONLY additional params a plan may set (filtered, never trusted). */
  readonly paramKeys: readonly string[];
  /** The param the Vesper-authored prompt is delivered in. */
  readonly promptParam: string;
  /** Hard ceiling on parallel instances of this pipeline within one step. */
  readonly maxInstances: number;
  /** Whether a per-run model override may be applied. */
  readonly acceptsModel: boolean;
  /** True when the pipeline spawns its own children (forces a sibling run). */
  readonly spawnsOwnChildren: boolean;
  /** The capabilities its task declares (the spawn grant / run ceiling). */
  readonly capabilities: readonly Capability[];
}

/**
 * The static contract map — the ONLY pipelines an orchestration plan may name.
 * Each entry's `capabilities` mirrors the pipeline's own `required_capabilities`
 * (the single source of truth), so a plan task never widens a grant.
 */
export const ORCHESTRATION_CONTRACTS: Readonly<Record<string, OrchestrationContract>> = {
  [SELFTEST_HANDLER_ID]: {
    handlerId: SELFTEST_HANDLER_ID,
    summary: "answers one prompt through the configured CLI (a single completion)",
    paramKeys: [],
    promptParam: "prompt",
    maxInstances: 3,
    acceptsModel: true,
    spawnsOwnChildren: false,
    capabilities: selftestTaskInput.required_capabilities ?? [],
  },
  [LOOP_HANDLER_ID]: {
    handlerId: LOOP_HANDLER_ID,
    summary:
      "autonomous reasoning loop toward an objective; the model authors each iteration's prompt",
    paramKeys: ["successCriteria", "maxIterations"],
    promptParam: "goal",
    maxInstances: 2,
    acceptsModel: true,
    spawnsOwnChildren: false,
    capabilities: loopTaskInput.required_capabilities ?? [],
  },
  [SOFTWARE_ENGINEER_HANDLER_ID]: {
    handlerId: SOFTWARE_ENGINEER_HANDLER_ID,
    summary:
      "human-gated coding cycle in a git worktree (needs a `repo` path param; stages, never commits)",
    paramKeys: ["repo"],
    promptParam: "wish",
    maxInstances: 1,
    acceptsModel: true,
    spawnsOwnChildren: true,
    capabilities: softwareEngineerTaskInput.required_capabilities ?? [],
  },
};
