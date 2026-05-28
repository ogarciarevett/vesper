import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@vesper/core";
import { dispatch } from "../dispatch.ts";
import { registry } from "./index.ts";

let tempHome: string;
let originalVesperHome: string | undefined;

beforeEach(() => {
  tempHome = join(tmpdir(), `vesper-runs-test-${crypto.randomUUID()}`);
  mkdirSync(tempHome, { recursive: true });
  originalVesperHome = process.env.VESPER_HOME;
  process.env.VESPER_HOME = tempHome;
});

afterEach(() => {
  if (originalVesperHome !== undefined) process.env.VESPER_HOME = originalVesperHome;
  else delete process.env.VESPER_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

/** Seed the runs table via the public store, oldest-first. */
function seedRuns(rows: readonly { pipeline: string; status: string; summary: string }[]): void {
  const store = openStore(join(tempHome, "vesper.db"));
  for (const r of rows) store.recordRun(r);
  store.close();
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: intentional interception
  (process.stdout as any).write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore original
    (process.stdout as any).write = original;
  }
  return chunks.join("");
}

describe("vesper runs list", () => {
  test("prints a placeholder when no runs exist", async () => {
    const out = await captureStdout(() => dispatch(registry, ["runs", "list"]));
    expect(out).toContain("no runs recorded");
  });

  test("lists recorded runs with pipeline, status, and summary", async () => {
    seedRuns([
      { pipeline: "echo", status: "ok", summary: "hello back" },
      { pipeline: "skill-train", status: "no_change", summary: "no improvement" },
    ]);
    const out = await captureStdout(() => dispatch(registry, ["runs", "list"]));
    expect(out).toContain("echo");
    expect(out).toContain("hello back");
    expect(out).toContain("skill-train");
    expect(out).toContain("no_change");
  });

  test("--pipeline filters to one pipeline", async () => {
    seedRuns([
      { pipeline: "echo", status: "ok", summary: "E" },
      { pipeline: "skill-train", status: "ok", summary: "S" },
    ]);
    const out = await captureStdout(() =>
      dispatch(registry, ["runs", "list", "--pipeline", "echo"]),
    );
    expect(out).toContain("echo");
    expect(out).not.toContain("skill-train");
  });

  test("--status filters by status", async () => {
    seedRuns([
      { pipeline: "echo", status: "ok", summary: "good" },
      { pipeline: "echo", status: "error", summary: "(empty response)" },
    ]);
    const out = await captureStdout(() =>
      dispatch(registry, ["runs", "list", "--status", "error"]),
    );
    expect(out).toContain("(empty response)");
    expect(out).not.toContain("good");
  });
});
