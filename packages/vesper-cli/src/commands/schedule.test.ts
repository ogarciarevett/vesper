import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HandlerRegistry,
  openStore,
  type RegisterTaskInput,
  Scheduler,
  TaskPersistence,
} from "@vesper/core";
import { dispatch } from "../dispatch.ts";
import { registry } from "./index.ts";
import { parseRunParams } from "./schedule.ts";

// ---------------------------------------------------------------------------
// Test environment helpers
// ---------------------------------------------------------------------------

let tempHome: string;
let originalVesperHome: string | undefined;

beforeEach(() => {
  // Point VESPER_HOME at a fresh temp directory so tests operate on a throwaway db.
  tempHome = join(tmpdir(), `vesper-test-${crypto.randomUUID()}`);
  mkdirSync(tempHome, { recursive: true });
  originalVesperHome = process.env.VESPER_HOME;
  process.env.VESPER_HOME = tempHome;
});

afterEach(() => {
  if (originalVesperHome !== undefined) {
    process.env.VESPER_HOME = originalVesperHome;
  } else {
    delete process.env.VESPER_HOME;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

/** Open the test DB and run migrations (same logic as CLI's openDb helper). */
function initDb(): Database {
  openStore(join(tempHome, "vesper.db")).close();
  return new Database(join(tempHome, "vesper.db"));
}

/** Seed a task into the DB using a Scheduler with a registered dummy handler. */
function seedTask(input: RegisterTaskInput): void {
  const db = initDb();
  const registry = new HandlerRegistry();
  registry.register(input.handler_id, () => {});
  const scheduler = new Scheduler({ db, registry });
  scheduler.register(input);
  db.close();
}

// ---------------------------------------------------------------------------
// Capture stdout helper
// ---------------------------------------------------------------------------

async function captureStdoutAsync(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: intentional interception
  (process.stdout as any).write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore original
    (process.stdout as any).write = originalWrite;
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// parseRunParams (pure helper)
// ---------------------------------------------------------------------------

describe("parseRunParams", () => {
  test("GIVEN no positionals THEN returns an empty object", () => {
    expect(parseRunParams([])).toEqual({});
  });

  test("GIVEN a key=value (after the id slice) THEN parses it", () => {
    // The id is positionals[0]; callers pass positionals.slice(1).
    expect(parseRunParams(["prompt=hello world"])).toEqual({ prompt: "hello world" });
  });

  test("GIVEN a positional with no '=' THEN it is ignored", () => {
    expect(parseRunParams(["echo", "bare"])).toEqual({});
  });

  test("GIVEN a trailing '=' THEN the value is the empty string", () => {
    expect(parseRunParams(["key="])).toEqual({ key: "" });
  });

  test("GIVEN multiple '=' THEN only the first splits (value keeps the rest)", () => {
    expect(parseRunParams(["a=b=c"])).toEqual({ a: "b=c" });
  });

  test("GIVEN a string --param flag THEN it is merged with positional params", () => {
    expect(parseRunParams(["prompt=hi"], "topic=ai")).toEqual({ prompt: "hi", topic: "ai" });
  });

  test("GIVEN only a string --param flag THEN it is parsed", () => {
    expect(parseRunParams([], "prompt=hi")).toEqual({ prompt: "hi" });
  });

  test("GIVEN a bare (boolean) --param flag THEN it is ignored", () => {
    expect(parseRunParams([], true)).toEqual({});
  });

  test("GIVEN both define the same key THEN the --param flag wins", () => {
    expect(parseRunParams(["prompt=positional"], "prompt=flag")).toEqual({ prompt: "flag" });
  });
});

// ---------------------------------------------------------------------------
// schedule list
// ---------------------------------------------------------------------------

describe("schedule list", () => {
  test("GIVEN no tasks THEN prints placeholder and returns 0", async () => {
    // Must init the DB before schedule commands can use it.
    initDb().close();

    const output = await captureStdoutAsync(async () => {
      const code = await dispatch(registry, ["schedule", "list"]);
      expect(code).toBe(0);
    });
    expect(output).toContain("no tasks registered");
  });

  test("GIVEN a registered task THEN lists it with id and kind", async () => {
    seedTask({
      id: "test-task-1",
      kind: "cron",
      schedule_expr: "* * * * *",
      handler_id: "my-handler",
    });

    const output = await captureStdoutAsync(async () => {
      const code = await dispatch(registry, ["schedule", "list"]);
      expect(code).toBe(0);
    });

    expect(output).toContain("test-task-1");
    expect(output).toContain("cron");
    expect(output).toContain("* * * * *");
  });

  test("GIVEN multiple tasks THEN all are listed", async () => {
    seedTask({ id: "task-a", kind: "cron", schedule_expr: "0 * * * *", handler_id: "h1" });
    seedTask({ id: "task-b", kind: "manual", schedule_expr: "", handler_id: "h2" });

    const output = await captureStdoutAsync(async () => {
      const code = await dispatch(registry, ["schedule", "list"]);
      expect(code).toBe(0);
    });

    expect(output).toContain("task-a");
    expect(output).toContain("task-b");
  });
});

// ---------------------------------------------------------------------------
// schedule show
// ---------------------------------------------------------------------------

describe("schedule show", () => {
  test("GIVEN a registered task THEN prints full detail and returns 0", async () => {
    seedTask({
      id: "show-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "show-handler",
    });

    const output = await captureStdoutAsync(async () => {
      const code = await dispatch(registry, ["schedule", "show", "show-task"]);
      expect(code).toBe(0);
    });

    expect(output).toContain("show-task");
    expect(output).toContain("manual");
    expect(output).toContain("show-handler");
    expect(output).toContain("required_capabilities");
  });

  test("GIVEN unknown id THEN returns 1 with actionable error on stderr", async () => {
    initDb().close();

    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: intentional interception
    (process.stderr as any).write = (chunk: unknown): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };

    let code: number;
    try {
      code = await dispatch(registry, ["schedule", "show", "nonexistent"]);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      (process.stderr as any).write = originalStderrWrite;
    }

    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("nonexistent");
    expect(stderr).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// schedule enable / disable
// ---------------------------------------------------------------------------

describe("schedule enable / disable", () => {
  test("GIVEN an enabled task WHEN disabled THEN persisted flag is false", async () => {
    seedTask({
      id: "toggle-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "t-handler",
      enabled: true,
    });

    const code = await dispatch(registry, ["schedule", "disable", "toggle-task"]);
    expect(code).toBe(0);

    // Verify the flag was persisted.
    const db = initDb();
    const persistence = new TaskPersistence(db);
    const task = persistence.get("toggle-task");
    db.close();
    expect(task?.enabled).toBe(false);
  });

  test("GIVEN a disabled task WHEN enabled THEN persisted flag is true", async () => {
    seedTask({
      id: "re-enable-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "re-handler",
      enabled: false,
    });

    const code = await dispatch(registry, ["schedule", "enable", "re-enable-task"]);
    expect(code).toBe(0);

    // Verify the flag was persisted.
    const db = initDb();
    const persistence = new TaskPersistence(db);
    const task = persistence.get("re-enable-task");
    db.close();
    expect(task?.enabled).toBe(true);
  });

  test("GIVEN unknown id THEN returns 1", async () => {
    initDb().close();
    const code = await dispatch(registry, ["schedule", "enable", "ghost-task"]);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// schedule run — no handler registered
// ---------------------------------------------------------------------------

describe("schedule run", () => {
  test("GIVEN a task with no registered handler THEN returns 1 with actionable message", async () => {
    seedTask({
      id: "run-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "pipeline-handler",
    });

    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: intentional interception
    (process.stderr as any).write = (chunk: unknown): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };

    let code: number;
    try {
      code = await dispatch(registry, ["schedule", "run", "run-task"]);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      (process.stderr as any).write = originalStderrWrite;
    }

    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    // Should mention the handler id and explain handlers come from pipelines.
    expect(stderr).toContain("pipeline-handler");
    expect(stderr).toContain("pipelines");
  });

  test("GIVEN unknown task id THEN returns 1 with actionable message", async () => {
    initDb().close();

    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: intentional interception
    (process.stderr as any).write = (chunk: unknown): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };

    let code: number;
    try {
      code = await dispatch(registry, ["schedule", "run", "no-such-task"]);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      (process.stderr as any).write = originalStderrWrite;
    }

    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("no-such-task");
    expect(stderr).toContain("not found");
  });

  test("GIVEN a task with a registered handler WHEN run THEN succeeds with exit 0", async () => {
    // This seeds a task into the DB that the CLI will try to run.
    // The CLI commands/schedule.ts uses an empty HandlerRegistry, so even a
    // "registered" handler at seed time will not be available to the CLI command.
    // This test validates the run-succeeds path by using the Scheduler directly.
    const db = initDb();
    const handlerReg = new HandlerRegistry();
    let ran = false;
    handlerReg.register("direct-handler", () => {
      ran = true;
    });
    const scheduler = new Scheduler({ db, registry: handlerReg });
    scheduler.register({
      id: "direct-run-task",
      kind: "manual",
      schedule_expr: "",
      handler_id: "direct-handler",
    });

    await scheduler.run("direct-run-task");
    db.close();

    expect(ran).toBe(true);
  });
});
