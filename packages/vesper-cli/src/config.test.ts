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
