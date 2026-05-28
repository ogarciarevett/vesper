/**
 * Terminal output helpers. Color and emphasis are applied only when stdout is a
 * TTY and `NO_COLOR` is unset, so piped/redirected output and CI stay plain.
 * All formatting functions are pure (return strings); the `print*` helpers write
 * to stdout.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

type Style = Exclude<keyof typeof ANSI, "reset">;

/** Whether ANSI styling should be emitted right now. */
export function colorEnabled(): boolean {
  return process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
}

function paint(style: Style, text: string): string {
  return colorEnabled() ? `${ANSI[style]}${text}${ANSI.reset}` : text;
}

export const bold = (text: string): string => paint("bold", text);
export const dim = (text: string): string => paint("dim", text);
export const red = (text: string): string => paint("red", text);
export const green = (text: string): string => paint("green", text);
export const yellow = (text: string): string => paint("yellow", text);
export const cyan = (text: string): string => paint("cyan", text);

/** A health state used for status tokens. */
export type Health = "ok" | "warn" | "bad";

/** Render a short, colored status token for a health state. */
export function statusToken(health: Health, label: string): string {
  switch (health) {
    case "ok":
      return green(label);
    case "warn":
      return yellow(label);
    case "bad":
      return red(label);
  }
}

/** Format aligned `key  value` rows into a single block (pure; no I/O). */
export function formatKeyValues(rows: readonly (readonly [string, string])[]): string {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `  ${dim(key.padEnd(width))}  ${value}`).join("\n");
}

/** Visible length of a string, ignoring ANSI escape codes (for column alignment). */
export function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC must be matched literally
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad a (possibly ANSI-colored) string to `width` visible characters. */
export function padVisible(text: string, width: number): string {
  const extra = width - visibleLength(text);
  return extra > 0 ? `${text}${" ".repeat(extra)}` : text;
}

/**
 * Render an aligned table (bold headers, a dim rule, then rows) as a single
 * string. Cells may already contain ANSI color — width is measured by visible
 * length. Pure; no I/O. Columns are sized to the widest visible cell.
 */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, col) =>
    Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[col] ?? ""))),
  );
  const render = (cells: readonly string[], style?: (s: string) => string): string =>
    `  ${headers.map((_, col) => padVisible(style ? style(cells[col] ?? "") : (cells[col] ?? ""), widths[col] ?? 0)).join("  ")}`;
  const headerRow = render(headers, bold);
  const rule = `  ${widths.map((w) => dim("─".repeat(w))).join("  ")}`;
  const bodyRows = rows.map((row) => render(row));
  return [headerRow, rule, ...bodyRows].join("\n");
}

/** Write a line to stdout. */
export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

/** Write an error line to stderr. */
export function errorLine(text: string): void {
  process.stderr.write(`${red("error")}: ${text}\n`);
}

/** Print a titled section followed by aligned key/value rows. */
export function printSection(title: string, rows: readonly (readonly [string, string])[]): void {
  line(bold(title));
  line(formatKeyValues(rows));
}
