import { CommandNotFoundError, type ProcessRunner, runProcess } from "../process/run.ts";

/** Priority-ordered list of all known CLI adapter names. */
const KNOWN_ADAPTERS = ["claude", "opencode", "codex", "gemini"] as const;

/** Union of recognised adapter names. */
export type AdapterName = (typeof KNOWN_ADAPTERS)[number];

/**
 * Probe every known CLI by running `which <bin>` concurrently. Returns the
 * names (in priority order) of binaries that are present on PATH.
 *
 * If the `which` binary itself is missing (highly unlikely but handled),
 * the function returns an empty array rather than throwing.
 *
 * @param run - Injected process runner (defaults to `runProcess`). Tests mock
 *   this to simulate which-exits without touching the real filesystem.
 */
export async function detectAvailableCLIs(run: ProcessRunner = runProcess): Promise<string[]> {
  const results = await Promise.all(
    KNOWN_ADAPTERS.map(async (name) => {
      try {
        const res = await run("which", [name]);
        return res.exitCode === 0 ? name : null;
      } catch (err) {
        // CommandNotFoundError means `which` itself is not installed — treat as absent.
        if (err instanceof CommandNotFoundError) return null;
        // Any other spawn error: treat the adapter as not installed.
        return null;
      }
    }),
  );

  return results.filter((name): name is string => name !== null);
}

/**
 * Pick the default CLI adapter from the set of installed ones.
 *
 * Priority:
 * 1. `configuredDefault` — if provided and present in `installed`.
 * 2. First of `[claude, opencode, codex, gemini]` that is in `installed`.
 * 3. `undefined` — nothing installed.
 */
export function selectDefault(
  installed: readonly string[],
  configuredDefault?: string,
): string | undefined {
  if (configuredDefault !== undefined && installed.includes(configuredDefault)) {
    return configuredDefault;
  }

  for (const name of KNOWN_ADAPTERS) {
    if (installed.includes(name)) return name;
  }

  return undefined;
}
