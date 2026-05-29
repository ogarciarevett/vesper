import { describe, expect, test } from "bun:test";
import { injectReadmeCommands, README_BEGIN, README_END, renderCliDocs } from "./cli-docs.ts";
import { registry } from "./commands/index.ts";
import type { Command, CommandGroup, Registrable } from "./dispatch.ts";

const cmd = (name: string, summary: string, usage?: string): Command => ({
  name,
  summary,
  ...(usage !== undefined ? { usage } : {}),
  run: () => 0,
});

describe("renderCliDocs", () => {
  test("includes every top-level command and every group subcommand", () => {
    const md = renderCliDocs(registry);
    for (const entry of registry) {
      if ("subcommands" in entry) {
        const group = entry as CommandGroup;
        expect(md).toContain(`vesper ${group.name} `);
        for (const sub of group.subcommands) {
          expect(md).toContain(sub.summary.replace(/\|/g, "\\|"));
        }
      } else {
        expect(md).toContain(entry.summary.replace(/\|/g, "\\|"));
      }
    }
  });

  test("is deterministic for the same registry", () => {
    expect(renderCliDocs(registry)).toBe(renderCliDocs(registry));
  });

  test("prefers explicit usage, derives it otherwise", () => {
    const reg: Registrable[] = [
      cmd("hello", "say hi"),
      {
        name: "vault",
        summary: "secrets",
        subcommands: [cmd("set", "store", "vesper vault set <key>")],
      },
    ];
    const md = renderCliDocs(reg);
    expect(md).toContain("`vesper hello`"); // derived
    expect(md).toContain("`vesper vault set <key>`"); // explicit usage
  });

  test("escapes pipe characters in summaries", () => {
    const md = renderCliDocs([cmd("x", "a | b")]);
    expect(md).toContain("a \\| b");
  });

  test("starts with the DO-NOT-EDIT generated header and ends with a newline", () => {
    const md = renderCliDocs(registry);
    expect(md.startsWith("<!-- GENERATED")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("injectReadmeCommands", () => {
  const wrap = (inner: string): string => `# Vesper\n\n## Commands\n\n${inner}\n\n## Next\n`;

  test("replaces the marked block with the command table", () => {
    const before = wrap(`${README_BEGIN}\nOLD CONTENT\n${README_END}`);
    const after = injectReadmeCommands(before, registry);
    expect(after).not.toContain("OLD CONTENT");
    expect(after).toContain("| Command | Description |");
    expect(after).toContain("`vesper init`");
    // Surrounding content is preserved.
    expect(after.startsWith("# Vesper")).toBe(true);
    expect(after).toContain("## Next");
  });

  test("is idempotent — re-injecting yields the same output", () => {
    const once = injectReadmeCommands(wrap(`${README_BEGIN}\n${README_END}`), registry);
    expect(injectReadmeCommands(once, registry)).toBe(once);
  });

  test("returns the README unchanged when markers are absent", () => {
    const noMarkers = "# Vesper\n\nno markers here\n";
    expect(injectReadmeCommands(noMarkers, registry)).toBe(noMarkers);
  });
});
