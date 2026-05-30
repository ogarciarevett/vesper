import { describe, expect, test } from "bun:test";
import { renderLaunchAgentPlist } from "./launchd.ts";

describe("renderLaunchAgentPlist", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.ogarciarevett.vesper",
    programArguments: ["/usr/local/bin/bun", "/app/index.ts", "daemon", "run"],
    stdoutPath: "/home/u/.vesper/run/daemon.log",
    stderrPath: "/home/u/.vesper/run/daemon.log",
  });

  test("is a valid plist document with the label", () => {
    expect(plist.startsWith('<?xml version="1.0"')).toBe(true);
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain("<key>Label</key>\n  <string>com.ogarciarevett.vesper</string>");
  });

  test("includes every program argument in order", () => {
    expect(plist).toContain("<string>/usr/local/bin/bun</string>");
    expect(plist).toContain("<string>/app/index.ts</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>run</string>");
    // daemon must come before run.
    expect(plist.indexOf("<string>daemon</string>")).toBeLessThan(
      plist.indexOf("<string>run</string>"),
    );
  });

  test("enables boot persistence + crash recovery", () => {
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Background</string>");
  });

  test("escapes XML metacharacters in arguments", () => {
    const out = renderLaunchAgentPlist({
      label: "x",
      programArguments: ["/path/with <&> chars"],
      stdoutPath: "/log",
      stderrPath: "/log",
    });
    expect(out).toContain("/path/with &lt;&amp;&gt; chars");
    expect(out).not.toContain("<&>");
  });
});
