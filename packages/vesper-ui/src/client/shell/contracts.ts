/** Wire shapes for the shell's read-only section routes. The daemon (server.ts)
 * produces these; the client sections consume them. One source of truth so the
 * section modules and the server stay in lock-step. */

export interface CliStatus {
  readonly name: string;
  /** "ok" | "not_authenticated" | "not_installed" | "error". */
  readonly status: string;
  readonly ok: boolean;
}

/** GET /api/status — the Runtime panel + titlebar status pills. */
export interface StatusResponse {
  readonly version: string;
  /** Daemon uptime in ms (since the UI server started). */
  readonly uptimeMs: number;
  readonly socket: string;
  readonly defaultCli: string | null;
  readonly clis: readonly CliStatus[];
  readonly runs: number;
  readonly sessions: number;
  readonly uiPort: number;
  readonly theme: string;
}

/** GET /api/config — the Settings section (no secrets). */
export interface ConfigResponse {
  readonly defaultCli: string | null;
  readonly theme: string;
  readonly uiPort: number;
  readonly installedClis: readonly string[];
}

/** A channel/connection row — GET /api/connections. */
export interface ConnectionRow {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "channel" | "mcp";
  /** "ready" | "deferred" | "connected" | "not_configured". */
  readonly status: string;
  readonly docsUrl: string;
}

/** A scheduled task row — GET /api/schedule (mirrors PipelineConfig). */
export interface ScheduleRow {
  readonly id: string;
  readonly kind: string;
  readonly scheduleExpr: string;
  readonly enabled: boolean;
  readonly maxRunsPerDay: number | null;
  readonly requiredCapabilities: readonly string[];
}

/** A recorded run row — GET /api/runs (Diagnostics). */
export interface RunRow {
  readonly id: string;
  readonly pipeline: string;
  readonly status: string;
  readonly summary: string;
  readonly ts: number;
}
