import { VESPER_DEFAULT } from "./default-glyph.ts";
import type { BrandMark } from "./types.ts";

const REGISTRY = new Map<string, BrandMark>();

/** Register a brand mark (built-ins self-register on import of ./builtins.ts). */
export function registerMark(mark: BrandMark): void {
  REGISTRY.set(mark.id, mark);
}

/** All registered marks (e.g. for a theme picker). The Vesper fallback is implicit. */
export function listMarks(): readonly BrandMark[] {
  return [...REGISTRY.values()];
}

/**
 * Resolve an agent id or brand token to a mark. NEVER returns null — an unknown
 * agent falls back to {@link VESPER_DEFAULT}, so every node always has a logo.
 * Resolution order: strip a `presence:` prefix, then exact id -> id-prefix ->
 * id-substring -> the Vesper default.
 */
export function resolveMark(idOrBrand: string): BrandMark {
  const token = idOrBrand.startsWith("presence:") ? idOrBrand.slice("presence:".length) : idOrBrand;

  const exact = REGISTRY.get(token);
  if (exact !== undefined) return exact;

  for (const mark of REGISTRY.values()) {
    if (token.startsWith(mark.id)) return mark;
  }
  for (const mark of REGISTRY.values()) {
    if (mark.id.length >= 4 && token.includes(mark.id)) return mark;
  }
  return VESPER_DEFAULT;
}
