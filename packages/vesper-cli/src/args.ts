/** Result of parsing an argv slice into positionals and flags. */
export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Minimal argv parser (no dependency). Splits leading/embedded `--flag` and
 * `--flag=value` tokens from positional arguments. A bare `--flag` is `true`.
 *
 * Intentionally small: Vesper commands are `vesper <noun> <verb> [positionals] [--flags]`,
 * so we do not need short flags, negation, or clustering.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}
