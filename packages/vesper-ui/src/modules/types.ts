import type { RunOutcome } from "@vesper/core";
import type { Inhabitant } from "../world/types.ts";

/** An extra action a module adds to an agent's inspect card (e.g. "speak"). */
export interface AgentAffordance {
  readonly id: string;
  readonly label: string;
}

/** An optional scene overlay a module attaches to an agent (e.g. a speaker icon). */
export interface AgentDecoration {
  readonly kind: string;
}

/** What a module contributes to a single inhabitant. */
export interface AgentAddon {
  readonly affordances?: readonly AgentAffordance[];
  readonly decorations?: readonly AgentDecoration[];
}

/**
 * A pluggable UI module. Modules extend the base world without touching the core
 * experience: they augment agents with affordances/decorations and react to runs.
 * The MVP ships the registry with ZERO modules; the first planned module is Voice
 * (on `onRunCompleted`, speak the agent's summary via the Voice phase).
 */
export interface UiModule {
  readonly id: string;
  /** Contribute affordances/decorations for a given agent. */
  augmentAgent?(agent: Inhabitant): AgentAddon;
  /** React to a completed run (e.g. synthesize speech of `outcome.summary`). */
  onRunCompleted?(outcome: RunOutcome): void | Promise<void>;
}
