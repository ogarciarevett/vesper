import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig } from "./config.ts";

function tempConfigPath(): string {
  return join(tmpdir(), `vesper-cfg-${crypto.randomUUID()}.json`);
}

describe("normalizeConfig", () => {
  test("returns the default for non-objects", () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig("nope")).toEqual(DEFAULT_CONFIG);
  });

  test("keeps default + adapter overrides and drops junk", () => {
    const config = normalizeConfig({
      cli: { default: "claude", adapters: { claude: { command: "claude", args: ["-p"] }, bad: 5 } },
    });
    expect(config.cli.default).toBe("claude");
    expect(config.cli.adapters.claude).toEqual({ command: "claude", args: ["-p"] });
    expect(config.cli.adapters.bad).toEqual({});
  });

  test("omits default when absent", () => {
    expect(normalizeConfig({ cli: { adapters: {} } }).cli.default).toBeUndefined();
  });

  test("reads storage.redactRunSummaries only when true", () => {
    expect(normalizeConfig({ storage: { redactRunSummaries: true } }).storage).toEqual({
      redactRunSummaries: true,
    });
    // Absent or falsy => storage omitted entirely.
    expect(normalizeConfig({ cli: { adapters: {} } }).storage).toBeUndefined();
    expect(normalizeConfig({ storage: { redactRunSummaries: "yes" } }).storage).toBeUndefined();
  });

  describe("presence", () => {
    test("keeps a well-formed custom matcher", () => {
      const cfg = normalizeConfig({
        presence: {
          matchers: [
            { id: "mytool", label: "My Tool", kind: "cli", pattern: "(?:^|/)mytool(?:\\s|$)" },
          ],
        },
      });
      expect(cfg.presence?.matchers).toEqual([
        { id: "mytool", label: "My Tool", kind: "cli", pattern: "(?:^|/)mytool(?:\\s|$)" },
      ]);
    });

    test("keeps a valid exclude and drops matchers with a bad regex", () => {
      const cfg = normalizeConfig({
        presence: {
          matchers: [
            { id: "ok", label: "OK", kind: "app", pattern: "/Foo\\.app/", exclude: "--type=" },
            { id: "bad", label: "Bad", kind: "cli", pattern: "(unclosed" }, // invalid regex
          ],
        },
      });
      expect(cfg.presence?.matchers).toEqual([
        { id: "ok", label: "OK", kind: "app", pattern: "/Foo\\.app/", exclude: "--type=" },
      ]);
    });

    test("drops matchers missing fields or with an unknown kind", () => {
      const cfg = normalizeConfig({
        presence: {
          matchers: [
            { id: "x", label: "X", pattern: "x" }, // missing kind
            { id: "y", label: "Y", kind: "gui", pattern: "y" }, // bad kind
            { label: "Z", kind: "cli", pattern: "z" }, // missing id
            42, // not an object
          ],
        },
      });
      expect(cfg.presence).toBeUndefined(); // all dropped, no pollMs => no presence block
    });

    test("validates pollMs (positive finite number only)", () => {
      expect(normalizeConfig({ presence: { pollMs: 5000 } }).presence).toEqual({ pollMs: 5000 });
      expect(normalizeConfig({ presence: { pollMs: 0 } }).presence).toBeUndefined();
      expect(normalizeConfig({ presence: { pollMs: -1 } }).presence).toBeUndefined();
      expect(normalizeConfig({ presence: { pollMs: "fast" } }).presence).toBeUndefined();
    });

    test("omits presence entirely when absent or empty", () => {
      expect(normalizeConfig({ cli: { adapters: {} } }).presence).toBeUndefined();
      expect(normalizeConfig({ presence: { matchers: [] } }).presence).toBeUndefined();
    });
  });
});

describe("loadConfig / saveConfig", () => {
  test("missing file yields the default", async () => {
    expect(await loadConfig(tempConfigPath())).toEqual(DEFAULT_CONFIG);
  });

  test("round-trips through disk", async () => {
    const path = tempConfigPath();
    try {
      await saveConfig({ cli: { default: "codex", adapters: {} } }, path);
      const loaded = await loadConfig(path);
      expect(loaded.cli.default).toBe("codex");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
