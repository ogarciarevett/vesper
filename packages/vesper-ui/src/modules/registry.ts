import type { RunOutcome } from "@vesper/core";
import type { Inhabitant } from "../world/types.ts";
import type { AgentAddon, AgentAffordance, AgentDecoration, UiModule } from "./types.ts";

/**
 * Holds the registered {@link UiModule}s and fans world events / agent queries out
 * to them. Empty by default (the MVP enables zero modules); this is the locked
 * extension contract the Voice module (and others) plug into later.
 */
export class ModuleRegistry {
  readonly #modules: UiModule[] = [];

  constructor(modules: readonly UiModule[] = []) {
    this.#modules.push(...modules);
  }

  register(module: UiModule): void {
    this.#modules.push(module);
  }

  list(): readonly UiModule[] {
    return this.#modules;
  }

  /** Merge every module's contribution for one agent into a single addon. */
  addonsFor(agent: Inhabitant): AgentAddon {
    const affordances: AgentAffordance[] = [];
    const decorations: AgentDecoration[] = [];
    for (const m of this.#modules) {
      const addon = m.augmentAgent?.(agent);
      if (addon?.affordances) affordances.push(...addon.affordances);
      if (addon?.decorations) decorations.push(...addon.decorations);
    }
    return { affordances, decorations };
  }

  /** Notify every module of a completed run; isolate per-module failures. */
  async dispatchRunCompleted(outcome: RunOutcome): Promise<void> {
    await Promise.all(
      this.#modules.map(async (m) => {
        try {
          await m.onRunCompleted?.(outcome);
        } catch {
          // A misbehaving module must not break the world's live channel.
        }
      }),
    );
  }
}
