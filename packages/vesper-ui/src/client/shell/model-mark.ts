/// <reference lib="dom" />
/**
 * Provider marks for model identity badges (specs/orchestrator-home.md, slice G).
 *
 * Hand-authored inline monochrome SVGs (stroke = currentColor, 24x24 — the
 * shell's icon idiom): dependency-free, nothing hotlinked. `markFor` maps a
 * model id (preferred) or the serving CLI name (fallback, from `runs.ctx_cli`)
 * to a provider mark; unknown providers get a generic chip.
 */

const svg = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** A resolved provider mark: machine id, display label, inline SVG. */
export interface ModelMark {
  readonly provider: string;
  readonly label: string;
  readonly svg: string;
}

const MARKS: Readonly<Record<string, ModelMark>> = {
  anthropic: {
    provider: "anthropic",
    label: "Anthropic",
    // The slanted-gable "A" silhouette.
    svg: svg('<path d="M4 19 10.5 5h3L20 19"/><path d="M8.2 14.5h7.6"/>'),
  },
  openai: {
    provider: "openai",
    label: "OpenAI",
    // Hexagonal knot, simplified to a hex ring + inner rotation.
    svg: svg(
      '<path d="M12 3l7 4v8l-7 4-7-4V7z"/><path d="M12 8.2 15.4 10v3.8L12 15.8 8.6 13.8V10z"/>',
    ),
  },
  google: {
    provider: "google",
    label: "Google",
    // The Gemini four-point spark.
    svg: svg(
      '<path d="M12 3c.7 4.9 4.1 8.3 9 9-4.9.7-8.3 4.1-9 9-.7-4.9-4.1-8.3-9-9 4.9-.7 8.3-4.1 9-9z"/>',
    ),
  },
  xai: {
    provider: "xai",
    label: "xAI",
    svg: svg('<path d="M5 4l14 16M19 4 5 20"/>'),
  },
  generic: {
    provider: "generic",
    label: "Model",
    // A chip: square + pins.
    svg: svg(
      '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3"/>',
    ),
  },
};

/** Provider from a model id (e.g. "claude-opus-4-8[1m]", "gpt-5.5", "gemini-3.5-flash"). */
function providerOfModel(model: string): ModelMark | null {
  const m = model.toLowerCase();
  if (m.includes("claude") || m === "haiku" || m === "sonnet" || m === "opus") {
    return MARKS.anthropic ?? null;
  }
  if (m.startsWith("gpt") || m.includes("codex") || /^o[0-9]/.test(m)) return MARKS.openai ?? null;
  if (m.includes("gemini") || m.includes("flash")) return MARKS.google ?? null;
  if (m.includes("grok")) return MARKS.xai ?? null;
  return null;
}

/** Provider from the serving CLI name (the `runs.ctx_cli` fallback). */
function providerOfCli(cli: string): ModelMark | null {
  switch (cli.toLowerCase()) {
    case "claude":
      return MARKS.anthropic ?? null;
    case "codex":
      return MARKS.openai ?? null;
    case "gemini":
      return MARKS.google ?? null;
    default:
      return null;
  }
}

/**
 * Resolve the provider mark for a run: model id first (exact), serving CLI as
 * the fallback, generic chip when either exists but is unrecognized, null when
 * nothing is known (no badge at all).
 */
export function markFor(model: string | null, cli: string | null): ModelMark | null {
  if (model !== null) {
    return providerOfModel(model) ?? MARKS.generic ?? null;
  }
  if (cli !== null) {
    return providerOfCli(cli) ?? MARKS.generic ?? null;
  }
  return null;
}
