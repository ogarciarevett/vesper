import type { RunOutcome } from "@vesper/core";

/**
 * A pluggable UI module. Modules extend the app without touching the core
 * experience: they react to completed runs. The MVP ships the registry with ZERO
 * modules; the first planned module is Voice (on `onRunCompleted`, speak the run's
 * summary via the Voice phase). The earlier canvas-overlay surface
 * (`augmentAgent`/affordances/decorations) was retired with the pixel-art world.
 */
export interface UiModule {
  readonly id: string;
  /** React to a completed run (e.g. synthesize speech of `outcome.summary`). */
  onRunCompleted?(outcome: RunOutcome): void | Promise<void>;
}
