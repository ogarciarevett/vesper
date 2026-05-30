/// <reference lib="dom" />
import type { SceneGraph } from "../../world/types.ts";
import type { HitRegion, RenderOpts } from "../render.ts";

/**
 * A pluggable Vesper World renderer ("theme"). A theme owns HOW the world looks —
 * it draws the pure {@link SceneGraph} to the canvas and returns the click/hover
 * hit regions. The world MODEL, the daemon server, and the 127.0.0.1 guard are
 * frozen; a theme is a pure client-side presentation choice. `drawScene` keeps the
 * exact signature the render loop already calls, so themes are interchangeable.
 *
 * The brand/logo layer (resolveMark) is theme-AGNOSTIC and lives outside this
 * contract: every theme draws an agent's real logo through it, so "every agent
 * shows its logo" holds regardless of theme — a theme only chooses how to frame it.
 */
export interface WorldTheme {
  /** Stable id (e.g. "hearth", "cyberpunk") — the selection key. */
  readonly id: string;
  /** Human label for the theme picker (e.g. "Cozy Cottage", "Neon City"). */
  readonly displayName: string;
  drawScene(
    ctx: CanvasRenderingContext2D,
    scene: SceneGraph,
    w: number,
    h: number,
    t: number,
    opts: RenderOpts,
  ): HitRegion[];
}
