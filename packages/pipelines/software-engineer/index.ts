/**
 * Public surface of the software-engineer pipeline.
 *
 * The lead drives a visualized, human-gated coding cycle in a throwaway git
 * worktree; the BUILD sub-agent writes files into it. The host (daemon) composes
 * the production seams and shares one {@link ChangeDecisionCoordinator} between the
 * running pipeline and the UI decision route.
 */

export type { ChangeDecision, PendingChange } from "./changes.ts";
export { ChangeDecisionCoordinator, ChangeDecisionError } from "./changes.ts";
export type { CycleDeps, CycleResult, RunTestResult } from "./cycle.ts";
export { runCycle } from "./cycle.ts";
export { defaultBuildDeps, defaultLeadDeps } from "./defaults.ts";
export type {
  DiffHunk,
  DiffLine,
  FileDiff,
  FileStatus,
  ParsedDiff,
} from "./diff.ts";
export { contentHash, parseUnifiedDiff } from "./diff.ts";
export { type GitResult, type GitRunner, gitOrThrow, makeGitRunner } from "./git.ts";
export {
  createSoftwareEngineerHandler,
  createSweBuildHandler,
  type SweBuildDeps,
  softwareEngineerTaskInput,
} from "./handler.ts";
export {
  BUILD_CHILD_CAPABILITIES,
  LEAD_CAPABILITIES,
  SOFTWARE_ENGINEER_HANDLER_ID,
  SWE_BUILD_HANDLER_ID,
  SWE_SOURCE,
} from "./ids.ts";
export type { BuildFile } from "./prompts.ts";
export type { Worktree } from "./worktree.ts";
