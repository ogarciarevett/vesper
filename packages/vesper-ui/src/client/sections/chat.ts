/// <reference lib="dom" />
import type { ChatSessionRow, ChatTurnRow } from "../chat-types.ts";
import { ICONS } from "../shell/icons.ts";
import {
  injectStyle,
  type LiveMessage,
  type SectionContext,
  type SectionModule,
} from "../shell/section.ts";
import { ActivityRail } from "./activity-rail.ts";

const CHAT_CSS = `
  .chat-wrap { display: flex; height: 100%; min-height: 0; }
  .chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .chat-top { display: flex; align-items: center; gap: 10px; padding: 16px 24px 12px; border-bottom: 1px solid var(--border); }
  .chat-top h1 { font-size: 17px; font-weight: 700; margin: 0; }
  .chat-top .chat-mark { width: 18px; height: 18px; color: var(--accent); display: grid; place-items: center; }
  .chat-top .chat-mark svg { width: 18px; height: 18px; }
  .chat-top .chat-new { margin-left: auto; font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 13px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--ink); cursor: pointer; }
  .chat-top .chat-new:hover { border-color: var(--accent); }
  .chat-thread { flex: 1; overflow-y: auto; padding: 22px 24px; display: flex; flex-direction: column; gap: 12px; }
  .chat-empty { margin: auto; text-align: center; color: var(--ink-soft); max-width: 440px; }
  .chat-empty .ce-mark { color: var(--accent); width: 38px; height: 38px; margin: 0 auto 12px; }
  .chat-empty .ce-mark svg { width: 38px; height: 38px; }
  .chat-empty h2 { font-size: 22px; font-weight: 700; color: var(--ink); margin: 0 0 8px; }
  .chat-empty p { font-size: 15px; line-height: 1.6; margin: 0; }
  .bubble { max-width: 80%; padding: 12px 15px; border-radius: 16px; font-size: 15px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .bubble.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 5px; }
  .bubble.assistant { align-self: flex-start; background: var(--surface-2); color: var(--ink); border: 1px solid var(--border); border-bottom-left-radius: 5px; }
  .bubble.pending { opacity: 0.65; font-style: italic; }
  .bubble .watch { display: inline-flex; align-items: center; gap: 6px; margin-top: 9px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); cursor: pointer; background: var(--surface); color: var(--ink); font: inherit; font-size: 12.5px; font-weight: 600; }
  .bubble .watch:hover { background: var(--surface-strong); }
  .chat-composer { border-top: 1px solid var(--border); padding: 14px 20px calc(14px + env(safe-area-inset-bottom)); display: flex; gap: 10px; align-items: flex-end; }
  .chat-composer textarea { flex: 1; resize: none; min-height: 48px; max-height: 180px; padding: 13px 15px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface-2); color: var(--ink); font: inherit; font-size: 15px; line-height: 1.4; }
  .chat-composer textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .chat-composer textarea::placeholder { color: var(--ink-faint); }
  .chat-send { flex: none; min-height: 48px; padding: 0 22px; border: none; border-radius: 14px; font: inherit; font-size: 15px; font-weight: 700; color: #fff; background: var(--accent); cursor: pointer; box-shadow: 0 8px 22px rgba(124, 92, 255, 0.3); }
  .chat-send:hover { background: var(--accent-2); }
  .chat-send:disabled { opacity: 0.5; cursor: default; }
  .chat-rail { width: 336px; flex: none; border-left: 1px solid var(--border); background: var(--sidebar-bg); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur); padding: 18px 16px; }
  @media (max-width: 920px) { .chat-rail { display: none; } }
  .chat-suggest { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 18px; }
  .chat-suggest button { font: inherit; font-size: 13px; padding: 9px 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); color: var(--ink); cursor: pointer; text-align: left; max-width: 230px; }
  .chat-suggest button:hover { border-color: var(--accent); }
  .chat-suggest button .cs-id { font-weight: 700; display: block; }
  .chat-suggest button .cs-sub { color: var(--ink-soft); font-size: 11.5px; display: block; margin-top: 2px; }
`;

const MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.8 6.4L20 12l-6.2 1.8L12 22l-1.8-8.2L4 12l6.2-3.6L12 2z" fill="currentColor"/></svg>';

interface RenderedTurn {
  readonly role: ChatTurnRow["role"];
}

/**
 * Chat — talk to Vesper, and watch ONLY Vesper's own work in the activity rail.
 * A message is a manual run of the `router` pipeline via the EXISTING run path
 * (`POST /api/chat`); the assistant turn carries the `runId` the rail follows.
 * The transcript streams over the shared socket (`chat:<sessionId>`) and backfills
 * via `GET /api/chat/sessions/:id/turns` on load + reconnect.
 */
class ChatSection {
  readonly #ctx: SectionContext;
  readonly #thread: HTMLElement;
  readonly #empty: HTMLElement;
  readonly #text: HTMLTextAreaElement;
  readonly #send: HTMLButtonElement;
  readonly #rail: ActivityRail;

  #sessionId: string | null = null;
  #lastTs = 0;
  #sending = false;
  /** The growing assistant bubble fed by chat:delta frames; replaced by the final turn. */
  #streamRow: HTMLElement | null = null;
  readonly #seen = new Map<string, RenderedTurn>();

  constructor(ctx: SectionContext, host: HTMLElement) {
    injectStyle("chat-css", CHAT_CSS);
    this.#ctx = ctx;

    this.#thread = div("chat-thread");
    this.#thread.setAttribute("role", "log");
    this.#thread.setAttribute("aria-live", "polite");
    this.#empty = div("chat-empty");
    this.#empty.innerHTML = `<div class="ce-mark">${MARK}</div><h2>What would you like done?</h2><p>Type a message — or pick a pipeline to start. Vesper sets it to work and you can watch it happen on the right.</p>`;
    this.#thread.append(this.#empty);
    void this.#renderLauncher();

    this.#text = document.createElement("textarea");
    this.#text.rows = 1;
    this.#text.placeholder = "Message Vesper…  (Enter to send)";
    this.#text.setAttribute("aria-label", "Message Vesper");
    this.#send = document.createElement("button");
    this.#send.type = "submit";
    this.#send.className = "chat-send";
    this.#send.textContent = "Send";

    const form = document.createElement("form");
    form.className = "chat-composer";
    form.append(this.#text, this.#send);

    const top = div("chat-top");
    top.innerHTML = `<span class="chat-mark">${MARK}</span><h1>Chat with Vesper</h1>`;
    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.className = "chat-new";
    fresh.textContent = "New conversation";
    fresh.addEventListener("click", () => this.#newConversation());
    top.append(fresh);

    const main = div("chat-main");
    main.append(top, this.#thread, form);

    const railHost = div("chat-rail");
    this.#rail = new ActivityRail(railHost, ctx);

    const wrap = div("chat-wrap");
    wrap.append(main, railHost);
    host.classList.add("flush");
    host.append(wrap);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.#submit();
    });
    this.#text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.#submit();
      }
    });
    this.#text.addEventListener("input", () => this.#autosize());

    ctx.onLive((msg) => this.#onLive(msg));
    ctx.onCleanup(() => {
      if (this.#sessionId !== null) ctx.wsSend({ type: "unsubscribe", sessionId: this.#sessionId });
      this.#rail.destroy();
    });

    void this.#restoreLatest();
    setTimeout(() => this.#text.focus(), 0);
  }

  #autosize(): void {
    this.#text.style.height = "auto";
    this.#text.style.height = `${this.#text.scrollHeight}px`;
  }

  /** Start a fresh thread: the empty state (and its pipeline launcher) comes back. */
  #newConversation(): void {
    if (this.#sessionId !== null) {
      this.#ctx.wsSend({ type: "unsubscribe", sessionId: this.#sessionId });
    }
    this.#sessionId = null;
    this.#lastTs = 0;
    this.#seen.clear();
    this.#clearStream();
    this.#thread.replaceChildren(this.#empty);
    this.#empty.style.display = "";
    this.#text.focus();
  }

  /**
   * The empty-state pipeline launcher (specs/pipeline-editor.md, home fix): every
   * runnable pipeline as a card. Clicking pre-fills the composer with a starter
   * wish — the router (the orchestrator) takes it from there, so there is no
   * second run path and no params dead-end for a brand-new user.
   */
  async #renderLauncher(): Promise<void> {
    interface Suggestion {
      readonly id: string;
      readonly label: string;
      readonly sub: string;
      readonly starter: string;
    }
    const suggestions: Suggestion[] = [];
    try {
      const custom =
        await this.#ctx.api.getJson<Array<{ id: string; name: string }>>("/api/pipelines/custom");
      for (const row of custom) {
        suggestions.push({
          id: row.id,
          label: row.name,
          sub: "your pipeline",
          starter: `Run my "${row.name}" pipeline`,
        });
      }
    } catch {
      // The launcher is a nicety — the composer still works without it.
    }
    const builtinStarters: ReadonlyArray<readonly [string, string, string]> = [
      ["selftest", "Check that Vesper is working", "Run a self-test to check everything works"],
      ["loop", "Work toward a goal by itself", "Use the loop pipeline to "],
      [
        "software-engineer",
        "Code a change in one of my repos",
        "Use the software-engineer pipeline on the repo at ",
      ],
      ["skill-train", "Train one of my skills", "Train the skill named "],
    ];
    for (const [id, label, starter] of builtinStarters) {
      suggestions.push({ id, label, sub: id, starter });
    }

    const wrap = div("chat-suggest");
    for (const suggestion of suggestions.slice(0, 8)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = `<span class="cs-id"></span><span class="cs-sub"></span>`;
      (btn.firstChild as HTMLElement).textContent = suggestion.label;
      (btn.lastChild as HTMLElement).textContent = suggestion.sub;
      btn.addEventListener("click", () => {
        this.#text.value = suggestion.starter;
        this.#autosize();
        this.#text.focus();
        this.#text.setSelectionRange(this.#text.value.length, this.#text.value.length);
      });
      wrap.append(btn);
    }
    this.#empty.append(wrap);
  }

  #onLive(msg: LiveMessage): void {
    if (msg.type === "chat:turn") {
      this.#onLiveTurn(msg);
    } else if (msg.type === "chat:delta") {
      this.#onDelta(msg);
    } else if (msg.type === "socket:open") {
      // Reconnected — re-subscribe + re-backfill the session and the followed run.
      if (this.#sessionId !== null) {
        this.#ctx.wsSend({ type: "subscribe", sessionId: this.#sessionId });
        void this.#backfill();
      }
      this.#rail.resubscribe();
    } else {
      this.#rail.handleLive(msg);
    }
  }

  #onLiveTurn(frame: LiveMessage): void {
    if (typeof frame.turnId !== "string" || typeof frame.text !== "string") return;
    const role = frame.role === "user" ? "user" : "assistant";
    const runId = typeof frame.runId === "string" ? frame.runId : null;
    // The durable assistant turn replaces the streamed bubble (it carries the
    // full text + the Watch button) — drop the stream so the text never doubles.
    if (role === "assistant") this.#clearStream();
    this.#renderTurn({ id: frame.turnId, role, text: frame.text, runId });
  }

  /** Append a streamed delta to the growing assistant bubble (created on first delta). */
  #onDelta(frame: LiveMessage): void {
    if (typeof frame.text !== "string" || frame.text.length === 0) return;
    if (this.#streamRow === null) {
      // The stream supersedes the static "thinking..." placeholder.
      this.#thread.querySelector(".bubble.pending")?.remove();
      this.#streamRow = div("bubble assistant streaming");
      this.#thread.append(this.#streamRow);
    }
    this.#streamRow.textContent = (this.#streamRow.textContent ?? "") + frame.text;
    this.#scrollToEnd();
  }

  #clearStream(): void {
    this.#streamRow?.remove();
    this.#streamRow = null;
  }

  async #submit(): Promise<void> {
    const message = this.#text.value.trim();
    if (message.length === 0 || this.#sending) return;
    this.#sending = true;
    this.#send.disabled = true;
    this.#text.value = "";
    this.#autosize();
    const optimisticId = `pending:${Date.now()}`;
    this.#renderTurn({ id: optimisticId, role: "user", text: message, runId: null });
    const thinking = this.#renderPending();

    try {
      // Generate the session id CLIENT-side for a new conversation and subscribe
      // BEFORE sending, so the very first reply's chat:delta stream is received
      // (the server creates an unknown supplied id on demand).
      if (this.#sessionId === null) {
        this.#sessionId = crypto.randomUUID();
        this.#ctx.wsSend({ type: "subscribe", sessionId: this.#sessionId });
      }
      const body = await this.#ctx.api.postJson<{ sessionId?: string; runId?: string | null }>(
        "/api/chat",
        { sessionId: this.#sessionId, message },
      );
      thinking.remove();
      if (typeof body.sessionId !== "string") {
        this.#ctx.toast("could not send");
        return;
      }
      if (typeof body.runId === "string") void this.#rail.follow(body.runId);
      await this.#backfill();
    } catch (err) {
      thinking.remove();
      this.#clearStream();
      this.#ctx.toast(err instanceof Error ? err.message : "could not send");
    } finally {
      this.#sending = false;
      this.#send.disabled = false;
      this.#text.focus();
    }
  }

  async #backfill(): Promise<void> {
    if (this.#sessionId === null) return;
    try {
      const turns = await this.#ctx.api.getJson<ChatTurnRow[]>(
        `/api/chat/sessions/${encodeURIComponent(this.#sessionId)}/turns?afterTs=${this.#lastTs}`,
      );
      for (const t of turns) {
        this.#renderTurn(t);
        if (t.ts > this.#lastTs) this.#lastTs = t.ts;
      }
    } catch {
      // transient; the next frame or reconnect recovers.
    }
  }

  async #restoreLatest(): Promise<void> {
    try {
      const sessions = await this.#ctx.api.getJson<ChatSessionRow[]>("/api/chat/sessions");
      const latest = sessions[0];
      if (latest === undefined) return;
      this.#sessionId = latest.id;
      this.#ctx.wsSend({ type: "subscribe", sessionId: latest.id });
      await this.#backfill();
    } catch {
      // no prior sessions / transient — the empty state stays.
    }
  }

  #renderPending(): HTMLElement {
    const row = div("bubble assistant pending");
    row.textContent = "thinking…";
    this.#thread.append(row);
    this.#scrollToEnd();
    return row;
  }

  #renderTurn(turn: {
    id: string;
    role: ChatTurnRow["role"];
    text: string;
    runId: string | null;
  }): void {
    if (this.#seen.has(turn.id)) return;
    if (turn.role === "user") this.#dropOptimistic();
    this.#empty.style.display = "none";

    const row = div(`bubble ${turn.role}`);
    row.dataset.turnId = turn.id;
    const textNode = document.createElement("div");
    textNode.textContent = turn.text;
    row.append(textNode);

    if (turn.role === "assistant" && turn.runId !== null) {
      const runId = turn.runId;
      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "watch";
      watch.innerHTML = `<span style="width:14px;height:14px;display:inline-grid;place-items:center">${ICONS.diagnostics}</span> Watch it work`;
      watch.addEventListener("click", () => void this.#rail.follow(runId));
      row.append(watch);
    }

    this.#thread.append(row);
    this.#seen.set(turn.id, { role: turn.role });
    this.#scrollToEnd();
  }

  #dropOptimistic(): void {
    const pending = this.#thread.querySelector<HTMLElement>('[data-turn-id^="pending:"]');
    if (pending !== null) {
      const id = pending.dataset.turnId;
      if (id !== undefined) this.#seen.delete(id);
      pending.remove();
    }
  }

  #scrollToEnd(): void {
    this.#thread.scrollTop = this.#thread.scrollHeight;
  }
}

function div(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export const chatSection: SectionModule = {
  id: "chat",
  title: "Chat",
  group: "primary",
  glyph: ICONS.chat,
  mount(host, ctx) {
    new ChatSection(ctx, host);
  },
};
