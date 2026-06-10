import {
  buildAdapter,
  CLIError,
  type CompleteFn,
  type CompleteResult,
  DEFAULT_MODEL_CATALOG,
  type ModelCatalogEntry,
  type ProcessRunner,
  selectDefault,
} from "@vesper/core";
import type { VesperConfig } from "./config.ts";

/** The effective catalog: user config entries win per key over the built-ins. */
export function effectiveCatalog(
  config: VesperConfig,
): Readonly<Record<string, ModelCatalogEntry>> {
  return { ...DEFAULT_MODEL_CATALOG, ...(config.models?.catalog ?? {}) };
}

/**
 * Resolve a requested model to an (adapter, flag-value) pair.
 *
 * A canonical catalog id picks BOTH the adapter and the flag value; anything else
 * is treated as a raw flag value for whichever adapter ends up serving the call
 * (the CLI itself rejects a bad model id, which surfaces honestly as nonzero_exit).
 */
function resolveModel(config: VesperConfig, model: string): { cli?: string; flag: string } {
  const entry = effectiveCatalog(config)[model];
  if (entry !== undefined) return { cli: entry.cli, flag: entry.flag };
  return { flag: model };
}

/**
 * Infer the serving CLI from a raw model id's shape — how live-directory picks
 * (e.g. "claude-opus-4-8", "gpt-5.5", "gemini-3.5-flash") route to the right
 * adapter without a catalog entry. Used ONLY when neither the catalog nor an
 * explicit `opts.cli` named one, so an override (e.g. opencode running a claude
 * model) is never second-guessed.
 */
export function inferModelCli(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.startsWith("claude") || m === "haiku" || m === "sonnet" || m === "opus") return "claude";
  if (m.startsWith("gpt-") || m.startsWith("codex") || /^o[0-9]/.test(m)) return "codex";
  if (m.startsWith("gemini")) return "gemini";
  return undefined;
}

/**
 * Build the CLI resolver the scheduler injects as `ctx.complete`.
 *
 * Resolution order: explicit per-run override (must be installed) -> the model
 * catalog's adapter (when `opts.model` names a catalog entry whose CLI is
 * installed) -> the configured default -> priority order
 * (`claude > opencode > codex > gemini`).
 *
 * Model routing must never kill a run: a catalog entry whose CLI is NOT installed
 * drops the model selection and falls back to the default resolution; an explicit
 * `opts.cli` that CONFLICTS with the catalog entry's CLI is an error (the caller
 * asked for two different things — never silently pick one).
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

    const requested = opts?.model !== undefined ? resolveModel(config, opts.model) : undefined;
    if (requested?.cli !== undefined && override !== undefined && requested.cli !== override) {
      throw new CLIError(
        "not_installed",
        `model "${opts?.model}" is served by "${requested.cli}" but cli "${override}" was requested — drop one`,
      );
    }
    // Raw (non-catalog) ids route by shape — but only when nothing else chose
    // the adapter, so explicit overrides keep running any model they like.
    const inferred =
      requested !== undefined &&
      requested.cli === undefined &&
      override === undefined &&
      opts?.model !== undefined
        ? inferModelCli(opts.model)
        : undefined;
    const routedCli = requested?.cli ?? inferred;
    // A model whose CLI is not installed is DROPPED (fall back to the
    // default resolution with no model flag) — routing never kills a run.
    const modelCli =
      routedCli !== undefined && installed.includes(routedCli) ? routedCli : undefined;
    const modelFlag =
      requested === undefined
        ? undefined
        : routedCli === undefined || modelCli !== undefined
          ? requested.flag
          : undefined;

    // An explicit, installed override is honored verbatim — "decide the LLM from
    // the request" must never silently fall back to another adapter. Only the
    // no-override case consults the catalog / configured default / priority order.
    const name = override ?? modelCli ?? selectDefault(installed, config.cli.default);
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

    return adapter.complete(prompt, {
      ...(modelFlag !== undefined ? { model: modelFlag } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.onText !== undefined ? { onText: opts.onText } : {}),
    });
  };
}

/**
 * Build the AGENTIC completion the channel-setup coordinator drives — the user's CLI
 * runs its own agent-browser skill to mint a channel token. Same resolution as
 * {@link makeCompleteFn} (configured default -> priority order), but invokes the adapter
 * in agentic mode with a generous per-call timeout (browser work runs for minutes). The
 * adapter's `agenticArgs` (config) carry the tool permissions an unattended browser needs.
 */
export function makeAgenticCompleteFn(
  config: VesperConfig,
  installed: readonly string[],
  run?: ProcessRunner,
): (prompt: string, opts: { agentic: true; timeoutMs: number }) => Promise<CompleteResult> {
  return async (prompt, opts) => {
    const name = selectDefault(installed, config.cli.default);
    if (name === undefined) {
      throw new CLIError("not_installed", "no CLI configured — run `vesper init`");
    }
    const adapterConfig = config.cli.adapters[name];
    const adapter = buildAdapter(name, {
      ...adapterConfig,
      ...(run !== undefined ? { run } : {}),
    });
    if (adapter === undefined) throw new CLIError("not_installed", `unknown CLI adapter "${name}"`);
    return adapter.complete(prompt, opts);
  };
}
