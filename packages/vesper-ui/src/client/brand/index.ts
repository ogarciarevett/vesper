// Theme-agnostic brand/logo layer — the "every agent shows its real logo" seam.
import "./builtins.ts"; // side-effect: registers the built-in marks

export { VESPER_DEFAULT } from "./default-glyph.ts";
export { listMarks, registerMark, resolveMark } from "./registry.ts";
export type { BrandMark } from "./types.ts";
