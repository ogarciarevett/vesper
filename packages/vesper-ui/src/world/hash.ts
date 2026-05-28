/** Deterministic 32-bit FNV-1a hash of a string → unsigned int. Pure, no deps. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (stay within 32 bits).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** A seeded float in [0,1) derived from a string — deterministic. */
export function seededUnit(input: string): number {
  return fnv1a(input) / 0xffffffff;
}
