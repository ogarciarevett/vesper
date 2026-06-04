import type { RunOutcome } from "@vesper/core";
import type { UiModule } from "./types.ts";

/**
 * Holds the registered {@link UiModule}s and fans run-completion events out to
 * them. Empty by default (the MVP enables zero modules); this is the locked
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

  /** Notify every module of a completed run; isolate per-module failures. */
  async dispatchRunCompleted(outcome: RunOutcome): Promise<void> {
    await Promise.all(
      this.#modules.map(async (m) => {
        try {
          await m.onRunCompleted?.(outcome);
        } catch {
          // A misbehaving module must not break the live channel.
        }
      }),
    );
  }
}
