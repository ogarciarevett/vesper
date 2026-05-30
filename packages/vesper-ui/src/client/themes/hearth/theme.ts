import { drawScene } from "../../render.ts";
import { registerTheme } from "../../theme/registry.ts";

/**
 * Theme #1 — "Cozy Cottage" (Hearth-Cottage). The shipped renderer (render.ts)
 * IS this theme's drawScene; registering it behind the WorldTheme contract makes
 * the renderer pluggable with zero behavior change. It is the default theme.
 */
registerTheme({ id: "hearth", displayName: "Cozy Cottage", drawScene }, { default: true });
