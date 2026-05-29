import type { AgentMatcherSpec, AgentPresence, ProcessRow } from "./types.ts";

/**
 * Built-in allowlist of known agent processes, matched against the full command
 * line. App matchers are anchored to the *main* executable
 * (`/<App>.app/Contents/MacOS/<App>`) so the Electron helper swarm under
 * `Contents/Frameworks` never registers as a separate agent. CLI matchers look
 * for the tool name as a path component or bare token (CLIs run under
 * `node`/`bun`, so `comm` is useless) and exclude `.app/` to avoid the desktop app.
 *
 * App matchers come first so an app's main process binds to its app rule
 * (first-match-wins) rather than the broader CLI rule.
 *
 * NOTE: the CLI patterns are best-effort and should be validated against a live
 * `claude`/`codex`/`opencode`/`gemini`/`zeroclaw` CLI session; the allowlist is
 * overridable via `~/.vesper/config.json` (`presence.matchers`).
 */
export const DEFAULT_AGENT_MATCHERS: readonly AgentMatcherSpec[] = [
  {
    id: "claude-app",
    label: "Claude (desktop)",
    kind: "app",
    pattern: "/Claude\\.app/Contents/MacOS/Claude(?:$| )",
  },
  {
    id: "codex-app",
    label: "Codex (desktop)",
    kind: "app",
    pattern: "/Codex\\.app/Contents/MacOS/Codex(?:$| )",
  },
  {
    id: "claude-cli",
    label: "Claude Code",
    kind: "cli",
    pattern: "claude-code(?:/|\\s|$)|(?:^|/)claude(?:\\s|$)",
    exclude: "\\.app/",
  },
  {
    id: "codex-cli",
    label: "Codex",
    kind: "cli",
    pattern: "(?:^|/)codex(?:\\s|$)",
    exclude: "\\.app/",
  },
  {
    id: "opencode-cli",
    label: "opencode",
    kind: "cli",
    pattern: "(?:^|/)opencode(?:\\s|$)",
    exclude: "\\.app/",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    kind: "cli",
    pattern: "(?:^|/)gemini(?:\\s|$)",
    exclude: "\\.app/",
  },
  {
    id: "zeroclaw-cli",
    label: "Zeroclaw",
    kind: "cli",
    pattern: "(?:^|/)zeroclaw(?:\\s|$)",
    exclude: "\\.app/",
  },
];

interface CompiledMatcher {
  readonly spec: AgentMatcherSpec;
  readonly pattern: RegExp;
  readonly exclude?: RegExp;
}

function compile(specs: readonly AgentMatcherSpec[]): CompiledMatcher[] {
  return specs.map((spec) => ({
    spec,
    pattern: new RegExp(spec.pattern, "i"),
    exclude: spec.exclude !== undefined ? new RegExp(spec.exclude, "i") : undefined,
  }));
}

/** The first matcher whose pattern matches `args` and whose exclude does not. */
function matchRow(args: string, matchers: readonly CompiledMatcher[]): CompiledMatcher | undefined {
  return matchers.find((m) => m.pattern.test(args) && m.exclude?.test(args) !== true);
}

/**
 * Group running processes into the agents they belong to (pure; no I/O).
 *
 * Each row is assigned to at most one matcher (first match wins). All rows for a
 * matcher collapse into a single {@link AgentPresence}: the representative is the
 * process with the shortest args (the bare main executable, not a long-arg
 * helper), and `procCount` is how many processes matched. Results are sorted by
 * label for stable rendering.
 *
 * @param rows - The current process table.
 * @param matchers - The allowlist (defaults available as {@link DEFAULT_AGENT_MATCHERS}).
 */
export function detectAgents(
  rows: readonly ProcessRow[],
  matchers: readonly AgentMatcherSpec[],
): AgentPresence[] {
  const compiled = compile(matchers);
  const groups = new Map<string, ProcessRow[]>();

  for (const r of rows) {
    const matched = matchRow(r.args, compiled);
    if (matched === undefined) continue;
    const bucket = groups.get(matched.spec.id);
    if (bucket === undefined) groups.set(matched.spec.id, [r]);
    else bucket.push(r);
  }

  const byId = new Map(compiled.map((m) => [m.spec.id, m.spec]));
  const presences: AgentPresence[] = [];
  for (const [id, group] of groups) {
    const spec = byId.get(id);
    if (spec === undefined) continue;
    const representative = group.reduce((shortest, r) =>
      r.args.length < shortest.args.length ? r : shortest,
    );
    presences.push({
      id,
      label: spec.label,
      kind: spec.kind,
      pid: representative.pid,
      procCount: group.length,
      since: representative.etime,
    });
  }

  return presences.sort((a, b) => a.label.localeCompare(b.label));
}
