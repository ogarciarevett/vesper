import { describe, expect, test } from "bun:test";
import { dispatch, type Registrable } from "./dispatch.ts";

function makeRegistry(calls: string[]): Registrable[] {
  return [
    {
      name: "ping",
      summary: "ping command",
      run: () => {
        calls.push("ping");
        return 0;
      },
    },
    {
      name: "grp",
      summary: "a group",
      subcommands: [
        {
          name: "sub",
          summary: "a subcommand",
          run: ({ positionals }) => {
            calls.push(`sub:${positionals.join(",")}`);
            return 7;
          },
        },
      ],
    },
  ];
}

describe("dispatch", () => {
  test("runs a leaf command and returns its exit code", async () => {
    const calls: string[] = [];
    expect(await dispatch(makeRegistry(calls), ["ping"])).toBe(0);
    expect(calls).toEqual(["ping"]);
  });

  test("no command prints help and returns 0", async () => {
    expect(await dispatch(makeRegistry([]), [])).toBe(0);
  });

  test("unknown command returns 1", async () => {
    expect(await dispatch(makeRegistry([]), ["nope"])).toBe(1);
  });

  test("resolves a group subcommand with the remaining positionals", async () => {
    const calls: string[] = [];
    expect(await dispatch(makeRegistry(calls), ["grp", "sub", "x", "y"])).toBe(7);
    expect(calls).toEqual(["sub:x,y"]);
  });

  test("a group with no subcommand returns 1", async () => {
    expect(await dispatch(makeRegistry([]), ["grp"])).toBe(1);
  });

  test("--help on a command returns 0 without running it", async () => {
    const calls: string[] = [];
    expect(await dispatch(makeRegistry(calls), ["ping", "--help"])).toBe(0);
    expect(calls).toEqual([]);
  });

  test("an error thrown by a command is caught and returns 1", async () => {
    const registry: Registrable[] = [
      {
        name: "boom",
        summary: "throws",
        run: () => {
          throw new Error("kaboom");
        },
      },
    ];
    expect(await dispatch(registry, ["boom"])).toBe(1);
  });
});
