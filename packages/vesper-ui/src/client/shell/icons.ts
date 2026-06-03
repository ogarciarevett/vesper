/** Inline SVG glyphs for the shell — line icons (stroke = currentColor), 24x24.
 * Theme-agnostic; the sidebar tints them via a per-section gradient class. */

const svg = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS: Record<string, string> = {
  chat: svg(
    '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/>',
  ),
  pipelines: svg(
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 10v4.5A1.5 1.5 0 0 0 8 16h6"/>',
  ),
  channels: svg(
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5 10.5 16M16 7.5 13.5 16"/>',
  ),
  schedule: svg(
    '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 2.5v4M16 2.5v4M12 13v3l2 1"/>',
  ),
  skills: svg('<path d="M12 2 3 7l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/>'),
  memory: svg(
    '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16M15 4v16M4 9h5M4 15h5M15 9h5M15 15h5"/>',
  ),
  runtime: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  ),
  cli: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>'),
  permissions: svg(
    '<path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5l-8-3z"/><path d="m9 12 2 2 4-4"/>',
  ),
  sandbox: svg(
    '<path d="M12 2 3 6.5V12c0 5 4 8 9 10 5-2 9-5 9-10V6.5L12 2z"/><path d="M12 7v10M7 12h10"/>',
  ),
  voice: svg(
    '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  ),
  settings: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 13H4a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11 4.6V4a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-1.2 2.9H20a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.4.9z"/>',
  ),
  diagnostics: svg('<path d="M3 12h4l2 6 4-13 2.5 7H21"/>'),
  about: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
};

/** A small status dot SVG (filled) — used by the titlebar pills. */
export const DOT =
  '<svg viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>';
