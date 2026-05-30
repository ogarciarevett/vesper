/// <reference lib="dom" />

/** localStorage key for the user's last-picked theme. */
const STORE_KEY = "vesper:theme";

/** Theme id from a URL query string (`?theme=cyberpunk`), or null. Pure. */
export function readUrlTheme(search: string): string | null {
  const m = /[?&]theme=([a-z0-9-]+)/i.exec(search);
  return m?.[1] ?? null;
}

/**
 * Pick the active theme id by precedence: explicit URL `?theme=` > the user's
 * stored choice > the daemon's configured default > null (let the registry pick
 * its default). Pure — the readers below supply the inputs.
 */
export function pickThemeId(inputs: {
  readonly url: string | null;
  readonly stored: string | null;
  readonly serverDefault: string | null;
}): string | null {
  return inputs.url ?? inputs.stored ?? inputs.serverDefault ?? null;
}

/** The user's stored theme choice (null in private mode / when unset). */
export function readStoredTheme(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

/** Persist the user's theme choice (best-effort; ignored if storage is unavailable). */
export function storeTheme(id: string): void {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    // private mode / storage disabled — selection just won't persist.
  }
}

/** The daemon's configured default, stamped into the page as <meta name="vesper-theme">. */
export function readServerDefaultTheme(): string | null {
  const content = document.querySelector('meta[name="vesper-theme"]')?.getAttribute("content");
  return content !== null && content !== undefined && content.length > 0 ? content : null;
}
