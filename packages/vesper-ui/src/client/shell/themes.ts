/// <reference lib="dom" />
import {
  pickThemeId,
  readServerDefaultTheme,
  readStoredTheme,
  readUrlTheme,
  storeTheme,
} from "../theme-store.ts";

/** A selectable chrome palette. The actual colors live as CSS vars under
 * `[data-theme="<id>"]` in the shell stylesheet — a theme is just an id + label. */
export interface ShellTheme {
  readonly id: string;
  readonly displayName: string;
}

/** Dark glass is the default app surface (OpenClaw-style); light/hearth are opt-in. */
export const THEMES: readonly ShellTheme[] = [
  { id: "dark", displayName: "Dark Glass" },
  { id: "glass", displayName: "Light Glass" },
  { id: "hearth", displayName: "Cottage" },
];

export const DEFAULT_THEME = "dark";

function themeExists(id: string | null | undefined): id is string {
  return id !== null && id !== undefined && THEMES.some((t) => t.id === id);
}

/** Drive the chrome palette off `<body data-theme>`; unknown ids fall back to dark. */
export function applyTheme(id: string | null | undefined): string {
  const resolved = themeExists(id) ? id : DEFAULT_THEME;
  document.body.dataset.theme = resolved;
  return resolved;
}

/**
 * Resolve the active theme on boot: URL `?theme=` > stored choice > daemon default
 * (`<meta name="vesper-theme">`) > {@link DEFAULT_THEME}. A `?theme=` visit is
 * remembered. Returns the applied id.
 */
export function bootTheme(): string {
  const url = readUrlTheme(window.location.search);
  if (url !== null) storeTheme(url);
  const picked = pickThemeId({
    url,
    stored: readStoredTheme(),
    serverDefault: readServerDefaultTheme(),
  });
  return applyTheme(themeExists(picked) ? picked : DEFAULT_THEME);
}

/** Switch theme and persist the choice (used by the Settings section). */
export function setTheme(id: string): string {
  storeTheme(id);
  return applyTheme(id);
}
