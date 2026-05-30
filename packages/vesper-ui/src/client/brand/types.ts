/// <reference lib="dom" />

/**
 * A brand mark for an agent — drawn procedurally on the Canvas (no image assets,
 * no network; local-first). The brand layer is THEME-AGNOSTIC: every WorldTheme
 * resolves and draws marks through it, so "every agent shows its real logo" is a
 * structural guarantee, not a per-theme convention. A theme chooses HOW to frame
 * a mark (cottage lantern vs neon holo-ring) but never WHETHER it appears.
 */
export interface BrandMark {
  /** Stable logo id, also the resolution key (e.g. "claude", "zeroclaw"). */
  readonly id: string;
  /** Human label (e.g. "Claude", "ZeroClaw"). */
  readonly label: string;
  /** Brand accent color (#rrggbb). */
  readonly color: string;
  /** Draw the mark centered at (cx, cy) within radius r, stroked/filled in its color. */
  readonly draw: (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) => void;
}
