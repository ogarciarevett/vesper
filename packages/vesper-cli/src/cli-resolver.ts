import {
  buildAdapter,
  CLIError,
  type CompleteFn,
  type ProcessRunner,
  selectDefault,
} from "@vesper/core";
import type { VesperConfig } from "./config.ts";

/**
 * Build the CLI resolver the scheduler injects as `ctx.complete`.
 *
 * Resolution order: explicit per-run override (must be installed) -> the
 * configured default -> priority order (`claude > opencode > codex > gemini`).
 *
 * `run` is the injectable process seam — tests pass a fake {@link ProcessRunner};
 * production omits it so the adapters use the real `runProcess`.
 */
export function makeCompleteFn(
  config: VesperConfig,
  installed: readonly string[],
  run?: ProcessRunner,
): CompleteFn {
  return async (prompt, opts) => {
    const override = opts?.cli;
    if (override !== undefined && !installed.includes(override)) {
      throw new CLIError("not_installed", `CLI "${override}" is not installed or not detected`);
    }

    // An explicit, installed override is honored verbatim — "decide the LLM from
    // the request" must never silently fall back to another adapter. Only the
    // no-override case consults the configured default / priority order.
    const name = override ?? selectDefault(installed, config.cli.default);
    if (name === undefined) {
      throw new CLIError(
        "not_installed",
        "no CLI configured — run `vesper init` or `vesper cli select <name>`",
      );
    }

    const adapterConfig = config.cli.adapters[name];
    const adapter = buildAdapter(name, {
      ...adapterConfig,
      ...(run !== undefined ? { run } : {}),
    });
    if (adapter === undefined) throw new CLIError("not_installed", `unknown CLI adapter "${name}"`);

    return adapter.complete(prompt);
  };
}
