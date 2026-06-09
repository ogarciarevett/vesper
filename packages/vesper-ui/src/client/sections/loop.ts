/// <reference lib="dom" />
import { ICONS } from "../shell/icons.ts";
import {
  h,
  injectStyle,
  type LiveMessage,
  type SectionContext,
  type SectionModule,
  sectionHeader,
} from "../shell/section.ts";

/**
 * Loop — autonomous, LLM-authored self-prompting loops (specs/autonomous-loop.md).
 *
 * The human sets ONLY the objective (and a hard iteration bound); per iteration the
 * model AUTHORs the next prompt, EXECUTEs it, and a CRITIC judges progress — all
 * through the user's own CLI. This section starts a loop (`POST /api/loop/run`) and
 * renders the author/execute/critic timeline live off the run-events WebSocket, so
 * you watch the loop think. v1 is a pure reasoning loop: it cannot write files,
 * fetch, or notify.
 */

interface LoopStartResponse {
  readonly runId?: string;
  readonly error?: string;
}

/** The `run:event` frame's event payload (the rail's RunEventInfo wire shape). */
interface LoopRunEvent {
  readonly id?: string;
  readonly runId?: string;
  readonly ts?: number;
  readonly kind?: string;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

const DEFAULT_ITERATIONS = 8;
const MAX_ITERATIONS = 50;
/** AUTHOR + EXECUTE + CRITIC per iteration. */
const CALLS_PER_ITERATION = 3;

const STYLE_ID = "sec-loop-style";
const STYLE = `
.loop-card { border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2);
  padding: 20px; max-width: 720px; display: flex; flex-direction: column; gap: 14px; }
.loop-lead { font-size: 15px; color: var(--ink); line-height: 1.5; margin: 0; }
.loop-note { font-size: 13px; color: var(--ink-soft); line-height: 1.55; margin: 0; }
.loop-form { display: flex; flex-direction: column; gap: 10px; }
.loop-goal { resize: vertical; min-height: 64px; }
.loop-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.loop-iters { width: 84px; }
.loop-cost { font-family: var(--mono); font-size: 12px; color: var(--ink-soft); }
.loop-timeline { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.loop-step { border: 1px solid var(--border); border-radius: 10px; background: rgba(255, 255, 255, 0.04);
  padding: 8px 12px; display: flex; align-items: baseline; gap: 10px; }
.loop-role { font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; flex: none; width: 64px; }
.loop-role.author { color: var(--accent); }
.loop-role.execute { color: var(--ink); }
.loop-role.critic { color: var(--ink-soft); }
.loop-msg { font-size: 13px; color: var(--ink); line-height: 1.45; margin: 0; word-break: break-word; }
.loop-final { font-size: 13px; line-height: 1.5; }
`;

/** Map a live-trace kind to the loop role it represents (the engine's mapping). */
function roleFor(kind: string): { label: string; cls: string } {
  switch (kind) {
    case "step":
      return { label: "AUTHOR", cls: "author" };
    case "log":
      return { label: "EXECUTE", cls: "execute" };
    case "progress":
      return { label: "CRITIC", cls: "critic" };
    default:
      return { label: kind.toUpperCase(), cls: "critic" };
  }
}

export const loopSection: SectionModule = {
  id: "loop",
  title: "Loop",
  group: "vesper",
  glyph: ICONS.loop,
  mount(host: HTMLElement, ctx: SectionContext) {
    injectStyle(STYLE_ID, STYLE);
    host.append(sectionHeader("Loop", "You set the objective — the model authors every prompt."));

    const goal = h("textarea", {
      class: "field loop-goal",
      placeholder: "What should the loop work toward? e.g. Draft a launch plan for…",
      "aria-label": "Loop objective",
    });
    const iterations = h("input", {
      class: "field loop-iters",
      type: "number",
      value: String(DEFAULT_ITERATIONS),
      min: "1",
      max: String(MAX_ITERATIONS),
      "aria-label": "Maximum iterations",
    });
    const start = h("button", { class: "btn primary", type: "submit" }, "Start loop");
    const cost = h("span", { class: "loop-cost", "aria-live": "polite" }, "");
    const status = h("p", { class: "loop-note", role: "status", "aria-live": "polite" }, "");
    const timeline = h("ul", {
      class: "loop-timeline",
      "aria-live": "polite",
      "aria-label": "Loop iterations",
    });

    const boundedIterations = (): number => {
      const n = Number(iterations.value);
      if (!Number.isInteger(n)) return DEFAULT_ITERATIONS;
      return Math.min(MAX_ITERATIONS, Math.max(1, n));
    };
    const updateCost = (): void => {
      cost.textContent = `up to ~${boundedIterations() * CALLS_PER_ITERATION} CLI calls (your own quota)`;
    };
    updateCost();
    iterations.addEventListener("input", updateCost);

    let followedRunId: string | null = null;
    const seenEventIds = new Set<string>();

    const appendStep = (event: LoopRunEvent): void => {
      if (typeof event.id === "string") {
        if (seenEventIds.has(event.id)) return; // live + backfill de-dupe
        seenEventIds.add(event.id);
      }
      const kind = event.kind ?? "";
      if (kind !== "step" && kind !== "log" && kind !== "progress") return;
      const role = roleFor(kind);
      timeline.append(
        h(
          "li",
          { class: "loop-step" },
          h("span", { class: `loop-role ${role.cls}` }, role.label),
          h("p", { class: "loop-msg" }, event.message ?? ""),
        ),
      );
    };

    const finish = (message: string): void => {
      if (followedRunId !== null) {
        ctx.wsSend({ type: "unsubscribe", runId: followedRunId });
        followedRunId = null;
      }
      status.textContent = message;
      start.removeAttribute("disabled");
    };

    ctx.onLive((msg: LiveMessage) => {
      if (followedRunId === null) return;
      if (msg.type === "run:event") {
        const event = msg.event as LoopRunEvent | undefined;
        if (event?.runId === followedRunId) appendStep(event);
      } else if (msg.type === "run:completed") {
        const outcome = msg.outcome as
          | { runId?: string | null; status?: string | null; summary?: string | null }
          | undefined;
        if (outcome?.runId === followedRunId) {
          finish(`${outcome.status ?? "finished"} — ${outcome.summary ?? ""}`);
        }
      }
    });
    ctx.onCleanup(() => {
      if (followedRunId !== null) ctx.wsSend({ type: "unsubscribe", runId: followedRunId });
    });

    const startLoop = async (): Promise<void> => {
      const objective = goal.value.trim();
      if (objective.length === 0) {
        status.textContent = "Give the loop an objective first.";
        return;
      }
      start.setAttribute("disabled", "");
      timeline.replaceChildren();
      seenEventIds.clear();
      status.textContent = "Starting the loop…";
      try {
        const res = await ctx.api.postJson<LoopStartResponse>("/api/loop/run", {
          goal: objective,
          maxIterations: boundedIterations(),
        });
        if (typeof res.runId !== "string") {
          finish(res.error ?? "the loop did not start");
          return;
        }
        followedRunId = res.runId;
        // Subscribe FIRST, then backfill: a reconnect-safe order (the rail's pattern);
        // `seenEventIds` de-dupes any frame that raced the backfill.
        ctx.wsSend({ type: "subscribe", runId: res.runId });
        status.textContent = "Loop running — watching it think…";
        const backfill = await ctx.api.getJson<LoopRunEvent[]>(
          `/api/runs/${encodeURIComponent(res.runId)}/events`,
        );
        for (const event of backfill) appendStep(event);
      } catch (err) {
        finish(err instanceof Error ? err.message : "the loop did not start");
      }
    };

    const form = h(
      "form",
      {
        class: "loop-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          void startLoop();
        },
      },
      goal,
      h(
        "div",
        { class: "loop-controls" },
        h("label", { class: "loop-note", for: "loop-iters" }, "Max iterations"),
        iterations,
        start,
        cost,
      ),
    );
    iterations.id = "loop-iters";

    host.append(
      h(
        "div",
        { class: "loop-card" },
        h(
          "p",
          { class: "loop-lead" },
          "An autonomous loop reasons toward your objective: each turn the model writes " +
            "the next prompt itself, runs it, and a critic judges the progress.",
        ),
        h(
          "p",
          { class: "loop-note" },
          "Hard-bounded and sandboxed: it stops at the iteration cap, on stalls, or when " +
            "the critic declares the objective met — and it can only think (no file, " +
            "network, or message access).",
        ),
        form,
        status,
        timeline,
      ),
    );
  },
};
