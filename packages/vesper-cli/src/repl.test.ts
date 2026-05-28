import { describe, expect, test } from "bun:test";
import { registry } from "./commands/index.ts";
import { commandList, parseRepl } from "./repl.ts";

describe("repl line parsing", () => {
  test("empty line is a noop", () => {
    expect(parseRepl("").kind).toBe("noop");
    expect(parseRepl("   ").kind).toBe("noop");
  });

  test("exit / quit leave the shell", () => {
    expect(parseRepl("exit").kind).toBe("exit");
    expect(parseRepl("quit").kind).toBe("exit");
  });

  test("clear and help are recognized", () => {
    expect(parseRepl("clear").kind).toBe("clear");
    expect(parseRepl("help").kind).toBe("help");
    expect(parseRepl("?").kind).toBe("help");
  });

  test("anything else becomes a run with split args", () => {
    const a = parseRepl("  schedule   list ");
    expect(a.kind).toBe("run");
    if (a.kind === "run") expect(a.args).toEqual(["schedule", "list"]);
  });
});

describe("repl command list", () => {
  test("lists the registered top-level commands", () => {
    const text = commandList(registry).join("\n");
    for (const name of ["init", "hello", "status", "schedule"]) {
      expect(text).toContain(name);
    }
  });
});
