import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_MATCHERS, detectAgents } from "./detect.ts";
import type { ProcessRow } from "./types.ts";

const row = (pid: number, args: string, etime = "01:00"): ProcessRow => ({ pid, args, etime });

// Real samples captured from `ps -axo pid,etime,args` on macOS (trimmed).
const CLAUDE_APP_MAIN = "/Applications/Claude.app/Contents/MacOS/Claude";
const CLAUDE_APP_GPU =
  "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process --user-data-dir=/x";
const CLAUDE_APP_RENDERER =
  "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer";
const CODEX_APP_MAIN = "/Applications/Codex.app/Contents/MacOS/Codex";
const CLAUDE_CLI_NODE =
  "node /Users/ogarcia/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js";

describe("detectAgents — desktop apps (verified real data)", () => {
  test("detects Claude.app via its main process, ignoring the helper swarm", () => {
    const rows = [
      row(953, "/Applications/Claude.app/.../chrome_crashpad_handler"),
      row(45702, CLAUDE_APP_MAIN),
      row(45705, CLAUDE_APP_GPU),
      row(45709, CLAUDE_APP_RENDERER),
      row(45711, CLAUDE_APP_RENDERER),
    ];
    const found = detectAgents(rows, DEFAULT_AGENT_MATCHERS);
    const claude = found.find((p) => p.id === "claude-app");
    expect(claude).toBeDefined();
    expect(claude?.kind).toBe("app");
    expect(claude?.pid).toBe(45702); // the main /MacOS/Claude process, not a helper
  });

  test("detects Codex.app", () => {
    const found = detectAgents([row(64258, CODEX_APP_MAIN)], DEFAULT_AGENT_MATCHERS);
    expect(found.some((p) => p.id === "codex-app" && p.kind === "app")).toBe(true);
  });

  test("does not match helper processes when the main app is absent", () => {
    // Only helpers (under Contents/Frameworks), no Contents/MacOS/Claude main.
    const found = detectAgents([row(45705, CLAUDE_APP_GPU)], DEFAULT_AGENT_MATCHERS);
    expect(found.some((p) => p.id === "claude-app")).toBe(false);
  });
});

describe("detectAgents — CLI agents", () => {
  test("detects the claude CLI running under node", () => {
    const found = detectAgents([row(12536, CLAUDE_CLI_NODE)], DEFAULT_AGENT_MATCHERS);
    expect(found.some((p) => p.id === "claude-cli" && p.kind === "cli")).toBe(true);
  });

  test("detects the zeroclaw CLI", () => {
    const found = detectAgents(
      [row(900, "/Users/me/.local/bin/zeroclaw chat")],
      DEFAULT_AGENT_MATCHERS,
    );
    const zc = found.find((p) => p.id === "zeroclaw-cli");
    expect(zc?.kind).toBe("cli");
    expect(zc?.label).toBe("Zeroclaw");
  });

  test("ignores unrelated processes (no false positives)", () => {
    const rows = [
      row(1, "/sbin/launchd"),
      row(2, "node /Users/me/projects/web/server.js"),
      row(3, "vim claude-notes.md"), // mentions 'claude' as a filename only
    ];
    const found = detectAgents(rows, DEFAULT_AGENT_MATCHERS);
    expect(found).toHaveLength(0);
  });
});

describe("detectAgents — semantics", () => {
  test("empty process table yields no presences", () => {
    expect(detectAgents([], DEFAULT_AGENT_MATCHERS)).toEqual([]);
  });

  test("a custom matcher list is honored (config-driven allowlist)", () => {
    const found = detectAgents(
      [row(10, "/usr/local/bin/mytool --serve")],
      [{ id: "mytool", label: "My Tool", kind: "cli", pattern: "(^|/)mytool(\\s|$)" }],
    );
    expect(found).toEqual([
      { id: "mytool", label: "My Tool", kind: "cli", pid: 10, procCount: 1, since: "01:00" },
    ]);
  });

  test("results are sorted by label for stable rendering", () => {
    const found = detectAgents(
      [row(64258, CODEX_APP_MAIN), row(45702, CLAUDE_APP_MAIN)],
      DEFAULT_AGENT_MATCHERS,
    );
    const labels = found.map((p) => p.label);
    expect(labels).toEqual([...labels].sort());
  });
});
