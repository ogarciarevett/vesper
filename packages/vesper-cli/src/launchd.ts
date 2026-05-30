/**
 * macOS LaunchAgent plist generation for the Vesper daemon. Pure string rendering
 * (no I/O) so it is unit-testable; the `vesper daemon install` command writes the
 * result and calls `launchctl`.
 */

/** Inputs for {@link renderLaunchAgentPlist}. */
export interface LaunchAgentOptions {
  /** Reverse-DNS label, e.g. "com.ogarciarevett.vesper". */
  readonly label: string;
  /** Argv that launchd runs, e.g. ["/path/to/bun", "/path/to/index.ts", "daemon", "run"]. */
  readonly programArguments: readonly string[];
  /** Where the daemon's stdout is written. */
  readonly stdoutPath: string;
  /** Where the daemon's stderr is written. */
  readonly stderrPath: string;
}

/** XML-escape a string for safe inclusion in plist text. */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a per-user LaunchAgent plist that starts the daemon at login and keeps it
 * alive. `RunAtLoad` + `KeepAlive` give crash recovery + boot persistence.
 */
export function renderLaunchAgentPlist(opts: LaunchAgentOptions): string {
  const args = opts.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.stderrPath)}</string>
</dict>
</plist>
`;
}
