/// <reference lib="dom" />
import type { RunContextInfo, RunEventInfo, RunTreeInfo } from "../../world/types.ts";
import { markFor } from "../shell/model-mark.ts";
import { injectStyle, type LiveMessage, type SectionContext } from "../shell/section.ts";
import { openDiffReview } from "./diff-review.ts";

const RAIL_CSS = `
  .rail { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .rail-head { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-soft); font-weight: 700; padding: 2px 2px 14px; }
  .rail-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .rail-rest { margin: auto; text-align: center; color: var(--ink-soft); font-size: 14px; line-height: 1.5; padding: 24px 12px; }
  .rail-rest .rr-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ink-faint); margin: 0 auto 12px; }
  .arow { border: 1px solid var(--border); border-radius: 13px; background: var(--surface-2); padding: 12px 13px; }
  .arow.child { margin-left: 16px; }
  .atop { display: flex; align-items: center; gap: 9px; }
  .atop .adot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
  .atop .adot.ok { background: var(--ok); } .atop .adot.error { background: var(--danger); }
  .aname { font-size: 14px; font-weight: 600; color: var(--ink); }
  .astatus { font-size: 12px; color: var(--ink-soft); margin-left: 10px; }
  .ctx-pill { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 11px; color: var(--ink-soft); }
  .ctx-pill .ctx-track { width: 46px; height: 6px; border-radius: 3px; background: var(--surface-strong, rgba(127,127,127,0.18)); overflow: hidden; }
  .ctx-pill .ctx-fill { display: block; height: 100%; border-radius: 3px; background: var(--ok); transition: width 0.3s ease; }
  .ctx-pill.warn .ctx-fill { background: #e0b341; }
  .ctx-pill.hot .ctx-fill, .ctx-pill.crit .ctx-fill { background: var(--danger); }
  .ctx-pill .ctx-pct { font-variant-numeric: tabular-nums; }
  .ctx-pill.muted { opacity: 0.55; }
  .alog { margin-top: 9px; display: flex; flex-direction: column; gap: 5px; max-height: 220px; overflow-y: auto; }
  .aevent { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
  .akind { flex: none; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent-2); min-width: 58px; }
  .amsg { color: var(--ink); word-break: break-word; }
  .alog .empty { font-size: 13px; color: var(--ink-faint); font-style: italic; }
  .amark { width: 15px; height: 15px; color: var(--ink-soft); display: inline-grid; place-items: center; flex: none; }
  .amark svg { width: 100%; height: 100%; }
  .amodel { font-size: 11px; color: var(--ink-soft); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aio { font-size: 12px; border: 1px solid var(--border); border-radius: 8px; background: rgba(0,0,0,0.25); }
  .aio summary { cursor: pointer; padding: 5px 9px; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); list-style: none; display: flex; gap: 8px; align-items: baseline; }
  .aio summary::before { content: "\25B8"; color: var(--ink-faint); }
  .aio[open] summary::before { content: "\25BE"; }
  .aio.err summary { color: var(--danger); }
  .aio pre { margin: 0; padding: 8px 10px; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; color: var(--ink); white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; border-top: 1px solid var(--border); }
  .aio.prompt pre { color: var(--ink-soft); }
  .swe-review { margin-top: 8px; }
  .swe-review-btn { padding: 5px 14px; border-radius: 8px; border: 1px solid var(--ok); background: rgba(58,208,127,0.1); color: var(--ok); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .swe-review-btn:hover:not(:disabled) { background: rgba(58,208,127,0.2); }
  .swe-review-btn:disabled { opacity: 0.5; cursor: default; }
  .swe-review-settled { font-size: 12px; color: var(--ink-faint); font-style: italic; }
`;

/** Parsed swe change state extracted from a run's event list. */
interface SweState {
  readonly changeId: string;
  readonly additions: number;
  readonly deletions: number;
  readonly settled: boolean;
}

/**
 * Scan a run's events for a `change_proposed` complete event and, if present,
 * note whether a subsequent `change_approved`/`change_rejected` event settled it.
 */
function sweStateFromEvents(events: RunEventInfo[], runId: string): SweState | null {
  let changeId: string | null = null;
  let additions = 0;
  let deletions = 0;
  let settled = false;
  for (const ev of events) {
    if (ev.runId !== runId || ev.kind !== "complete" || ev.data === undefined) continue;
    const swe = ev.data.swe;
    if (swe === "change_proposed") {
      const cid = ev.data.changeId;
      if (typeof cid === "string") {
        changeId = cid;
        additions = typeof ev.data.additions === "number" ? ev.data.additions : 0;
        deletions = typeof ev.data.deletions === "number" ? ev.data.deletions : 0;
      }
    } else if (swe === "change_approved" || swe === "change_rejected") {
      settled = true;
    }
  }
  if (changeId === null) return null;
  return { changeId, additions, deletions, settled };
}

/** Build the "Review change" button row for a proposed swe change. */
function buildReviewWrap(state: SweState, runId: string, ctx: SectionContext): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "swe-review";
  if (state.settled) {
    const settled = document.createElement("span");
    settled.className = "swe-review-settled";
    settled.textContent = "Change reviewed";
    wrap.append(settled);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swe-review-btn";
    btn.textContent = `Review change (+${state.additions} / -${state.deletions})`;
    const changeId = state.changeId;
    btn.addEventListener("click", () => openDiffReview(ctx, { runId, changeId }));
    wrap.append(btn);
  }
  return wrap;
}

/** Mark an existing review button row as settled (idempotent). */
function settleReviewWrap(row: HTMLElement): void {
  const existing = row.querySelector<HTMLElement>(".swe-review");
  if (existing === null) return;
  const btn = existing.querySelector<HTMLButtonElement>(".swe-review-btn");
  if (btn !== null) {
    // Replace button with settled label in-place
    const settled = document.createElement("span");
    settled.className = "swe-review-settled";
    settled.textContent = "Change reviewed";
    existing.replaceChildren(settled);
  }
}

/**
 * The Chat "Vesper activity" rail — a live tree of the run Vesper started for the
 * conversation (root + sub-agents), each with a streaming step log. Reflects ONLY
 * Vesper's own runs. Preserves the subscribe-before-backfill + de-dupe-by-event-id
 * behavior so a reconnect re-backfills missed steps without duplicate rows.
 */
export class ActivityRail {
  readonly #ctx: SectionContext;
  readonly #head: HTMLElement;
  readonly #body: HTMLElement;
  #runId: string | null = null;
  #subscribed: string[] = [];

  constructor(host: HTMLElement, ctx: SectionContext) {
    injectStyle("rail-css", RAIL_CSS);
    this.#ctx = ctx;
    host.classList.add("rail");
    this.#head = document.createElement("div");
    this.#head.className = "rail-head";
    this.#head.textContent = "Vesper activity";
    this.#body = document.createElement("div");
    this.#body.className = "rail-body";
    host.append(this.#head, this.#body);
    this.reset();
  }

  /** Calm "resting" state — Vesper has nothing in flight. */
  reset(): void {
    this.#runId = null;
    const rest = document.createElement("div");
    rest.className = "rail-rest";
    const dot = document.createElement("div");
    dot.className = "rr-dot";
    const text = document.createElement("div");
    text.textContent = "Vesper is resting. Send a message and watch it work here.";
    rest.append(dot, text);
    this.#body.replaceChildren(rest);
  }

  /** Re-follow the active run after a socket reconnect (re-subscribe + re-backfill). */
  resubscribe(): void {
    if (this.#runId !== null) void this.follow(this.#runId);
  }

  /** Follow a run: fetch its tree, subscribe + backfill every node, render live. */
  async follow(runId: string): Promise<void> {
    this.#runId = runId;
    try {
      const tree = await this.#ctx.api.getJson<RunTreeInfo>(
        `/api/runs/${encodeURIComponent(runId)}/tree`,
      );
      const ids: string[] = [];
      collectRunIds(tree, ids);
      for (const id of ids) this.#ctx.wsSend({ type: "subscribe", runId: id });
      this.#subscribed = ids;
      const perNode = await Promise.all(
        ids.map((id) =>
          this.#ctx.api
            .getJson<RunEventInfo[]>(`/api/runs/${encodeURIComponent(id)}/events`)
            .catch(() => [] as RunEventInfo[]),
        ),
      );
      if (this.#runId === runId) this.#render(tree, perNode.flat());
    } catch {
      // transient; live frames still append as they arrive.
    }
  }

  /** Route a live `/api/live` frame relevant to the followed run. */
  handleLive(msg: LiveMessage): void {
    if (this.#runId === null) return;
    if (msg.type === "run:event" && msg.event !== undefined) {
      this.#appendLive(msg.event as RunEventInfo);
    } else if (msg.type === "run:event:lite" && typeof msg.runId === "string") {
      // A run stepped; if a child row is missing the tree gained a sub-agent.
      if (this.#logFor(msg.runId) === null) void this.follow(this.#runId);
    } else if (msg.type === "run:completed") {
      const outcome = msg.outcome as { runId?: string | null } | undefined;
      if (outcome?.runId === this.#runId) void this.follow(this.#runId);
    }
  }

  /** Drop subscriptions when the section unmounts. */
  destroy(): void {
    for (const id of this.#subscribed) this.#ctx.wsSend({ type: "unsubscribe", runId: id });
    this.#subscribed = [];
    this.#runId = null;
  }

  #logFor(runId: string): HTMLElement | null {
    return this.#body.querySelector<HTMLElement>(`.alog[data-run-id="${runId}"]`);
  }

  #appendLive(ev: RunEventInfo): void {
    // A `usage` step is not a log line — it updates the run's context pill in place.
    if (ev.kind === "usage") {
      this.#updatePill(ev.runId, contextFromEventData(ev.data));
      return;
    }
    const log = this.#logFor(ev.runId);
    if (log === null) return;
    if (log.querySelector(`[data-event-id="${ev.id}"]`) !== null) return;
    appendEventRow(log, ev);
    // Handle swe change events: add/update the review button on the run row.
    if (ev.kind === "complete" && ev.data !== undefined) {
      const swe = ev.data.swe;
      if (typeof swe === "string") this.#updateReviewButton(ev.runId, swe, ev.data);
    }
  }

  #updateReviewButton(runId: string, swe: string, data: Record<string, unknown>): void {
    const log = this.#logFor(runId);
    if (log === null) return;
    const row = log.parentElement;
    if (row === null) return;

    if (swe === "change_proposed") {
      if (row.querySelector(".swe-review") !== null) return; // already present
      const cid = data.changeId;
      if (typeof cid !== "string") return;
      const additions = typeof data.additions === "number" ? data.additions : 0;
      const deletions = typeof data.deletions === "number" ? data.deletions : 0;
      const state: SweState = { changeId: cid, additions, deletions, settled: false };
      row.insertBefore(buildReviewWrap(state, runId, this.#ctx), log);
    } else if (swe === "change_approved" || swe === "change_rejected") {
      settleReviewWrap(row);
    }
  }

  #updatePill(runId: string, context: RunContextInfo | null): void {
    if (context === null) return;
    const pill = this.#body.querySelector<HTMLElement>(`.ctx-pill[data-ctx-run-id="${runId}"]`);
    if (pill !== null) renderContextPill(pill, context);
  }

  #render(tree: RunTreeInfo, events: RunEventInfo[]): void {
    this.#body.replaceChildren();
    this.#body.append(buildRunRow(tree, false, events, this.#ctx));
    for (const child of tree.children)
      this.#body.append(buildRunRow(child, true, events, this.#ctx));
  }
}

function collectRunIds(node: RunTreeInfo, into: string[]): void {
  into.push(node.run.id);
  for (const child of node.children) collectRunIds(child, into);
}

function appendEventRow(log: HTMLElement, ev: RunEventInfo): void {
  const empty = log.querySelector(".empty");
  if (empty !== null) empty.remove();
  // Completion IO: the sub-agent's input prompt / output text, terminal-style.
  if (ev.kind === "io") {
    log.append(buildIoRow(ev));
    log.scrollTop = log.scrollHeight;
    return;
  }
  const row = document.createElement("div");
  row.className = "aevent";
  row.dataset.eventId = ev.id;
  const kind = document.createElement("span");
  kind.className = "akind";
  kind.textContent = ev.kind;
  const msg = document.createElement("span");
  msg.className = "amsg";
  msg.textContent = ev.message;
  row.append(kind, msg);
  log.append(row);
  log.scrollTop = log.scrollHeight;
}

/**
 * One collapsible terminal block for an `io` event: PROMPT (dimmed) / RESULT /
 * ERROR with the full text body and the serving cli + model in the header.
 */
function buildIoRow(ev: RunEventInfo): HTMLElement {
  const phase = ev.message; // "prompt" | "result" | "error"
  const details = document.createElement("details");
  details.className = `aio ${phase === "prompt" ? "prompt" : phase === "error" ? "err" : "result"}`;
  details.dataset.eventId = ev.id;

  const summary = document.createElement("summary");
  const who: string[] = [phase.toUpperCase()];
  const cli = typeof ev.data?.cli === "string" ? ev.data.cli : null;
  const model = typeof ev.data?.model === "string" ? ev.data.model : null;
  if (cli !== null || model !== null) who.push([cli, model].filter((x) => x !== null).join(" · "));
  if (typeof ev.data?.durationMs === "number") who.push(`${ev.data.durationMs}ms`);
  if (ev.data?.truncated === true) who.push("truncated");
  summary.textContent = who.join("  ");
  const aria = `${phase} text`;
  summary.setAttribute("aria-label", aria);

  const pre = document.createElement("pre");
  pre.textContent = typeof ev.data?.text === "string" ? ev.data.text : "";

  details.append(summary, pre);
  return details;
}

function buildRunRow(
  node: RunTreeInfo,
  isChild: boolean,
  events: RunEventInfo[],
  ctx: SectionContext,
): HTMLElement {
  const row = document.createElement("div");
  row.className = isChild ? "arow child" : "arow";

  const top = document.createElement("div");
  top.className = "atop";
  const dot = document.createElement("span");
  const st = node.run.status;
  dot.className = `adot ${st === "ok" ? "ok" : st === "error" ? "error" : ""}`;
  const name = document.createElement("span");
  name.className = "aname";
  name.textContent = node.run.pipeline;
  const pill = document.createElement("span");
  pill.dataset.ctxRunId = node.run.id;
  renderContextPill(pill, node.run.context);
  const status = document.createElement("span");
  status.className = "astatus";
  status.textContent = node.run.status;
  top.append(dot, name);
  // Model identity badge: provider mark + model id (cli as the fallback).
  const mark = markFor(node.run.context?.model ?? null, node.run.cli);
  if (mark !== null) {
    const markEl = document.createElement("span");
    markEl.className = "amark";
    markEl.innerHTML = mark.svg;
    markEl.title = mark.label;
    const modelEl = document.createElement("span");
    modelEl.className = "amodel";
    modelEl.textContent = node.run.context?.model ?? node.run.cli ?? mark.label;
    top.append(markEl, modelEl);
  }
  top.append(pill, status);

  const log = document.createElement("div");
  log.className = "alog";
  log.dataset.runId = node.run.id;
  // `usage` steps drive the context pill (above), not the step log.
  const own = events.filter((e) => e.runId === node.run.id && e.kind !== "usage");
  if (own.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "no steps yet";
    log.append(empty);
  } else {
    for (const ev of own) appendEventRow(log, ev);
  }

  row.append(top);

  // Attach review button if a swe change_proposed event is present for this run.
  const sweState = sweStateFromEvents(events, node.run.id);
  if (sweState !== null) {
    row.append(buildReviewWrap(sweState, node.run.id, ctx));
  }

  row.append(log);
  return row;
}

/** Percentage fill for a run's context, or null when no usage is known. */
function pctOf(context: RunContextInfo | null): number | null {
  if (context === null || context.limit <= 0) return null;
  return Math.min(100, Math.round((context.usedTokens / context.limit) * 100));
}

/** Severity bucket mirroring the statusline HUD: ok <50, warn >=50, hot >=75, crit >=90. */
function ctxClass(pct: number): "ok" | "warn" | "hot" | "crit" {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "hot";
  if (pct >= 50) return "warn";
  return "ok";
}

/** Render (or re-render) a context pill in place: a small track + fill + percentage. */
function renderContextPill(pill: HTMLElement, context: RunContextInfo | null): void {
  pill.className = "ctx-pill";
  pill.replaceChildren();
  const pct = pctOf(context);
  if (pct === null) {
    pill.classList.add("muted");
    const label = document.createElement("span");
    label.textContent = "ctx --";
    pill.append(label);
    pill.title = "this agent's CLI did not report context usage";
    return;
  }
  const bucket = ctxClass(pct);
  if (bucket !== "ok") pill.classList.add(bucket);
  const track = document.createElement("span");
  track.className = "ctx-track";
  const fill = document.createElement("span");
  fill.className = "ctx-fill";
  fill.style.width = `${pct}%`;
  track.append(fill);
  const txt = document.createElement("span");
  txt.className = "ctx-pct";
  txt.textContent = `${pct}%`;
  pill.append(track, txt);
  if (context !== null) {
    const model = context.model !== null ? ` (${context.model})` : "";
    pill.title = `context ${context.usedTokens.toLocaleString()} / ${context.limit.toLocaleString()} tokens${model}`;
  }
}

/** Narrow a `usage` run-event's `data` payload into a {@link RunContextInfo}. */
function contextFromEventData(data: Record<string, unknown> | undefined): RunContextInfo | null {
  if (data === undefined) return null;
  const { usedTokens, limit, model } = data;
  if (typeof usedTokens !== "number" || typeof limit !== "number") return null;
  return { usedTokens, limit, model: typeof model === "string" ? model : null };
}
