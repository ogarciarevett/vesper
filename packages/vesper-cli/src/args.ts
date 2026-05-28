/** Result of parsing an argv slice into positionals and flags. */
export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Minimal argv parser (no dependency). Splits leading/embedded `--flag` and
 * `--flag=value` tokens from positional arguments. A bare `--flag` is `true`.
 *
 * `valueFlags` names the flags that take a space-separated value, so
 * `--cli claude` parses as `{ cli: "claude" }` instead of a boolean flag plus a
 * stray positional. A flag NOT in this set stays positional-order-independent
 * (a bare `--flag` is always `true`; following tokens remain positionals). The
 * `--flag=value` form always works regardless of `valueFlags`.
 *
 * Intentionally small: Vesper commands are `vesper <noun> <verb> [positionals] [--flags]`,
 * so we do not need short flags, negation, or clustering.
 */
export function parseArgs(
  argv: readonly string[],
  valueFlags: ReadonlySet<string> = new Set(),
): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }

      // A recognised value-flag consumes the next token, unless that token is
      // itself a flag or absent (then the flag is a bare boolean).
      const next = argv[i + 1];
      if (valueFlags.has(body) && next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}
