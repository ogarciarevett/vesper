/// <reference lib="dom" />
import type { ChatSessionRow, ChatTurnRow } from "./chat-types.ts";

/**
 * Dependencies the chat home borrows from {@link import("./main.ts")} — it REUSES
 * the existing live socket + activity panel rather than opening a second transport.
 */
export interface ChatDeps {
  /** Send a control frame on the existing `/api/live` socket (no-op when closed). */
  readonly wsSend: (payload: Record<string, unknown>) => void;
  /** Open the live activity panel for a run (the demoted canvas tree). */
  readonly openActivity: (runId: string) => void;
  /** Surface a transient message via the shared toast. */
  readonly toast: (message: string) => void;
}

/** A rendered transcript turn, keyed by its persisted turn id (for de-dupe). */
interface RenderedTurn {
  readonly id: string;
  readonly role: ChatTurnRow["role"];
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

/**
 * The chat home: the transcript column + input. A message is a manual run of the
 * `router` pipeline through the EXISTING run path (`POST /api/chat`); the assistant
 * turn carries the `runId` whose live tree the activity panel renders. The transcript
 * streams over the SAME `/api/live` socket (a `chat:<sessionId>` topic) and backfills
 * via `GET /api/chat/sessions/:id/turns` on load + reconnect.
 */
export class ChatHome {
  readonly #deps: ChatDeps;
  readonly #thread = el<HTMLElement>("chat-thread");
  readonly #empty = el<HTMLElement>("chat-empty");
  readonly #form = el<HTMLFormElement>("chat-form");
  readonly #text = el<HTMLTextAreaElement>("chat-text");
  readonly #send = el<HTMLButtonElement>("chat-send");

  /** The active session id (null until the first message creates one). */
  #sessionId: string | null = null;
  /** Highest turn ts we have rendered — the `afterTs` cursor for backfill. */
  #lastTs = 0;
  /** Turn ids already in the DOM (de-dupe live frames against backfilled twins). */
  readonly #seen = new Map<string, RenderedTurn>();
  /** True while a `POST /api/chat` is in flight (disables Send, shows a placeholder). */
  #sending = false;

  constructor(deps: ChatDeps) {
    this.#deps = deps;
    this.#form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.#submit();
    });
    // Enter sends; Shift+Enter inserts a newline (keyboard-friendly composer).
    this.#text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.#submit();
      }
    });
    this.#text.addEventListener("input", () => this.#autosize());
  }

  /** Grow the composer with its content, capped by CSS max-height. */
  #autosize(): void {
    this.#text.style.height = "auto";
    this.#text.style.height = `${this.#text.scrollHeight}px`;
  }

  /** Re-subscribe + re-backfill after a (re)connect, so no turn is missed. */
  onSocketOpen(): void {
    if (this.#sessionId !== null) {
      this.#deps.wsSend({ type: "subscribe", sessionId: this.#sessionId });
      void this.#backfill();
    }
  }

  /** A `chat:turn` frame arrived on the live socket — append it if it's ours. */
  onLiveTurn(frame: { turnId?: unknown; runId?: unknown; role?: unknown; text?: unknown }): void {
    if (typeof frame.turnId !== "string" || typeof frame.text !== "string") return;
    const role = frame.role === "user" ? "user" : "assistant";
    const runId = typeof frame.runId === "string" ? frame.runId : null;
    this.#renderTurn({ id: frame.turnId, role, text: frame.text, runId });
  }

  /** Submit the composer: POST /api/chat (the existing run path), then await frames. */
  async #submit(): Promise<void> {
    const message = this.#text.value.trim();
    if (message.length === 0 || this.#sending) return;
    this.#sending = true;
    this.#send.disabled = true;
    this.#text.value = "";
    this.#autosize();
    // Optimistic user bubble (replaced by the persisted twin when its frame lands).
    const optimisticId = `pending:${Date.now()}`;
    this.#renderTurn({ id: optimisticId, role: "user", text: message, runId: null });
    const thinking = this.#renderPending();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          this.#sessionId === null ? { message } : { sessionId: this.#sessionId, message },
        ),
      });
      const body = (await res.json()) as {
        sessionId?: string;
        turnId?: string;
        runId?: string | null;
        error?: string;
      };
      thinking.remove();
      if (!res.ok || typeof body.sessionId !== "string") {
        this.#deps.toast(body.error ?? "could not send");
        return;
      }
      // First message established a session — subscribe + adopt it. Frames for both
      // turns are published server-side; the backfill is the durable safety net.
      if (this.#sessionId === null) {
        this.#sessionId = body.sessionId;
        this.#deps.wsSend({ type: "subscribe", sessionId: body.sessionId });
      }
      await this.#backfill();
    } catch {
      thinking.remove();
      this.#deps.toast("could not send");
    } finally {
      this.#sending = false;
      this.#send.disabled = false;
      this.#text.focus();
    }
  }

  /** Fetch any turns after our cursor and render them (idempotent via #seen). */
  async #backfill(): Promise<void> {
    if (this.#sessionId === null) return;
    try {
      const url = `/api/chat/sessions/${encodeURIComponent(this.#sessionId)}/turns?afterTs=${this.#lastTs}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const turns = (await res.json()) as ChatTurnRow[];
      for (const t of turns) {
        this.#renderTurn(t);
        if (t.ts > this.#lastTs) this.#lastTs = t.ts;
      }
    } catch {
      // transient; the next frame or reconnect recovers.
    }
  }

  /** Restore the most recent session's transcript on first load (if any exists). */
  async restoreLatest(): Promise<void> {
    try {
      const res = await fetch("/api/chat/sessions");
      if (!res.ok) return;
      const sessions = (await res.json()) as ChatSessionRow[];
      const latest = sessions[0]; // server returns newest-first
      if (latest === undefined) return;
      this.#sessionId = latest.id;
      this.#deps.wsSend({ type: "subscribe", sessionId: latest.id });
      await this.#backfill();
    } catch {
      // no prior sessions / transient — the empty state stays.
    }
  }

  /** Append a "thinking…" placeholder; returns it so the caller can remove it. */
  #renderPending(): HTMLElement {
    const row = document.createElement("div");
    row.className = "bubble assistant pending";
    row.textContent = "thinking…";
    this.#thread.append(row);
    this.#scrollToEnd();
    return row;
  }

  /** Render (or, for the optimistic user turn, leave) one transcript bubble. */
  #renderTurn(turn: {
    id: string;
    role: ChatTurnRow["role"];
    text: string;
    runId: string | null;
  }): void {
    if (this.#seen.has(turn.id)) return; // de-dupe replayed/twin frames.
    // Drop the optimistic user bubble once the persisted user turn arrives.
    if (turn.role === "user") this.#dropOptimistic();
    this.#empty.style.display = "none";

    const row = document.createElement("div");
    row.className = `bubble ${turn.role}`;
    row.dataset.turnId = turn.id;
    const textNode = document.createElement("div");
    textNode.textContent = turn.text;
    row.append(textNode);

    // An assistant turn carries the run that produced it — offer to watch it live.
    if (turn.role === "assistant" && turn.runId !== null) {
      const runId = turn.runId;
      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "watch";
      watch.textContent = "Watch it work";
      watch.addEventListener("click", () => this.#deps.openActivity(runId));
      row.append(watch);
    }

    this.#thread.append(row);
    this.#seen.set(turn.id, { id: turn.id, role: turn.role });
    this.#scrollToEnd();
  }

  /** Remove the lone optimistic user bubble (id begins with `pending:`). */
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
