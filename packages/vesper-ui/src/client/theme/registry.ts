import type { WorldTheme } from "./types.ts";

const THEMES = new Map<string, WorldTheme>();
let defaultId: string | null = null;

/** Register a theme. The first registered (or one passed `default: true`) is the default. */
export function registerTheme(theme: WorldTheme, opts?: { readonly default?: boolean }): void {
  THEMES.set(theme.id, theme);
  if (opts?.default === true || defaultId === null) defaultId = theme.id;
}

/** All registered themes (for the picker). */
export function listThemes(): readonly WorldTheme[] {
  return [...THEMES.values()];
}

/**
 * Resolve the active theme: a valid `requested` id wins, else the default, else the
 * first registered. Unknown ids fall back (never throw) — same defensive shape as
 * the CLI's selectDefault. Throws only if NO theme is registered (a wiring bug).
 */
export function resolveTheme(requested?: string | null): WorldTheme {
  if (requested !== undefined && requested !== null) {
    const exact = THEMES.get(requested);
    if (exact !== undefined) return exact;
  }
  if (defaultId !== null) {
    const def = THEMES.get(defaultId);
    if (def !== undefined) return def;
  }
  const first = THEMES.values().next().value;
  if (first === undefined) throw new Error("no themes registered");
  return first;
}
