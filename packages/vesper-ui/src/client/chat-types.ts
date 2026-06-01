/**
 * Client-side wire shapes for the chatbot-home + templates routes. These mirror the
 * JSON the server serializes (see `server/server.ts`) — the browser bundle cannot
 * import `@vesper/core` row types directly, so they are restated structurally here.
 */

/** JSON of a `chat_sessions` row (`GET /api/chat/sessions`, newest-first). */
export interface ChatSessionRow {
  readonly id: string;
  readonly ts: number;
  readonly title: string;
}

/** JSON of a `chat_turns` row (`GET /api/chat/sessions/:id/turns`). */
export interface ChatTurnRow {
  readonly id: string;
  readonly sessionId: string;
  readonly ts: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly runId: string | null;
}

/** The editable-config view of a pipeline's `ScheduledTask` (`GET /api/pipelines`). */
export interface PipelineConfig {
  readonly id: string;
  readonly handlerId: string;
  readonly kind: string;
  readonly scheduleExpr: string;
  readonly enabled: boolean;
  readonly maxRunsPerDay: number | null;
  readonly maxConcurrent: number | null;
  readonly maxDurationMs: number | null;
  readonly requiredCapabilities: readonly string[];
}

/** Response of `GET /api/pipelines/:id/template`. */
export interface PipelineTemplate {
  readonly handlerId: string;
  readonly prompt: string;
  readonly defaultParams: Record<string, unknown>;
  readonly config: PipelineConfig;
}
