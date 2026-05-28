import { describe, expect, test } from "bun:test";
import type { RunOutcome } from "@vesper/core";
import type { Inhabitant } from "../world/types.ts";
import { ModuleRegistry } from "./registry.ts";
import type { UiModule } from "./types.ts";

const agent: Inhabitant = {
  id: "echo",
  label: "echo",
  x: 0.5,
  y: 0.5,
  prominence: 1,
  mood: "ok",
  avatarSeed: 1,
  enabled: true,
  runCount: 1,
  lastStatus: "ok",
  lastSummary: "hi",
  lastRunAt: 1,
};

const outcome: RunOutcome = {
  taskId: "echo",
  runId: "r1",
  status: "ok",
  summary: "hi",
  cli: null,
  durationMs: 1,
};

describe("ModuleRegistry", () => {
  test("is empty by default — no addons, no-op dispatch", async () => {
    const reg = new ModuleRegistry();
    expect(reg.list()).toHaveLength(0);
    expect(reg.addonsFor(agent)).toEqual({ affordances: [], decorations: [] });
    await reg.dispatchRunCompleted(outcome); // does not throw
  });

  test("merges addons from every module", () => {
    const voiceish: UiModule = {
      id: "voice",
      augmentAgent: () => ({ affordances: [{ id: "speak", label: "Speak" }] }),
    };
    const reg = new ModuleRegistry([voiceish]);
    reg.register({ id: "tag", augmentAgent: () => ({ decorations: [{ kind: "badge" }] }) });

    const addon = reg.addonsFor(agent);
    expect(addon.affordances).toEqual([{ id: "speak", label: "Speak" }]);
    expect(addon.decorations).toEqual([{ kind: "badge" }]);
  });

  test("dispatches run:completed to each module", async () => {
    const seen: string[] = [];
    const reg = new ModuleRegistry([
      { id: "a", onRunCompleted: (o) => void seen.push(`a:${o.taskId}`) },
      { id: "b", onRunCompleted: async (o) => void seen.push(`b:${o.status}`) },
    ]);
    await reg.dispatchRunCompleted(outcome);
    expect(seen.sort()).toEqual(["a:echo", "b:ok"]);
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
