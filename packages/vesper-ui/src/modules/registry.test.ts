import { describe, expect, test } from "bun:test";
import type { RunOutcome } from "@vesper/core";
import { ModuleRegistry } from "./registry.ts";

const outcome: RunOutcome = {
  taskId: "selftest",
  runId: "r1",
  status: "ok",
  summary: "hi",
  cli: null,
  durationMs: 1,
};

describe("ModuleRegistry", () => {
  test("is empty by default — no-op dispatch", async () => {
    const reg = new ModuleRegistry();
    expect(reg.list()).toHaveLength(0);
    await reg.dispatchRunCompleted(outcome); // does not throw
  });

  test("dispatches run:completed to each module", async () => {
    const seen: string[] = [];
    const reg = new ModuleRegistry([
      { id: "a", onRunCompleted: (o) => void seen.push(`a:${o.taskId}`) },
      { id: "b", onRunCompleted: async (o) => void seen.push(`b:${o.status}`) },
    ]);
    reg.register({ id: "c", onRunCompleted: (o) => void seen.push(`c:${o.runId}`) });
    await reg.dispatchRunCompleted(outcome);
    expect(seen.sort()).toEqual(["a:selftest", "b:ok", "c:r1"]);
  });

  test("isolates a throwing module so the channel survives", async () => {
    const seen: string[] = [];
    const reg = new ModuleRegistry([
      {
        id: "bad",
        onRunCompleted: () => {
          throw new Error("boom");
        },
      },
      { id: "good", onRunCompleted: () => void seen.push("good") },
    ]);
    await reg.dispatchRunCompleted(outcome); // must not reject
    expect(seen).toEqual(["good"]);
  });
});
