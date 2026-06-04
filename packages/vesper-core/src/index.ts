// @vesper/core — host runtime public surface.
// Modules are re-exported here as they land through the Foundation feature loop.

export * from "./approval/index.ts";
export * from "./auto-evolve/index.ts";
export * from "./capabilities/index.ts";
export * from "./cli/index.ts";
export * from "./connections/index.ts";
export { VesperError } from "./errors.ts";
export * from "./ipc/index.ts";
export * from "./media/index.ts";
export * from "./presence/index.ts";
export {
  CommandNotFoundError,
  type ProcessRunner,
  ProcessTimeoutError,
  type RunOptions,
  type RunResult,
  runProcess,
} from "./process/run.ts";
export * from "./scheduler/index.ts";
export * from "./skill-train/index.ts";
export * from "./storage/index.ts";
export * from "./vault/index.ts";
