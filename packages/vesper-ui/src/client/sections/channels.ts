/// <reference lib="dom" />
import { ICONS } from "../shell/icons.ts";
import {
  h,
  injectStyle,
  type SectionContext,
  type SectionModule,
  sectionHeader,
} from "../shell/section.ts";

/** One row of `GET /api/connections` (mirrors core `ChannelState`). */
interface ChannelRow {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly docsUrl: string;
  /** Whether this channel exposes a scan-to-connect pairing flow. */
  readonly pairable: boolean;
}

/**
 * A QR matrix from `GET /api/qr?data=...` — row-major, `modules[y * size + x]`,
 * `true` = a dark module. Defined locally so the browser bundle never imports
 * `@vesper/core` (whose barrel pulls `bun:sqlite`, which cannot run in a browser).
 */
interface QrMatrix {
  readonly size: number;
  readonly modules: readonly boolean[];
}

/**
 * One newline-delimited frame from `POST /api/connections/:id/pair`. `awaiting`
 * may repeat (a rotating code); any other status is terminal. Mirrors the core
 * `PairingUpdate` — declared locally to keep core out of the browser bundle.
 */
type PairingUpdate =
  | {
      readonly status: "awaiting";
      readonly prompt: {
        readonly kind: string;
        readonly data: string;
        readonly humanHint: string;
        readonly expiresAt: number;
      };
    }
  | { readonly status: "linked"; readonly chatId?: string; readonly label?: string }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "expired" };

/** MCP servers stay a read-only catalog this slice (no enable/disable yet). */
const MCP: readonly string[] = [
  "Linear",
  "Notion",
  "Gmail",
  "Google Calendar",
  "Google Drive",
  "Refero",
  "Bigdata.com",
  "Financial Modeling Prep",
  "ZipRecruiter",
  "Excalidraw",
];

const STYLE_ID = "sec-channels-style";
const STYLE = `
.cn-row { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
.cn-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cn-head .btn { min-height: 30px; padding: 0 14px; font-size: 13px; }
.cn-pair { margin-top: 10px; border: 1px solid var(--border-strong); border-radius: 12px;
  background: var(--surface-2); padding: 16px; display: flex; flex-direction: column;
  align-items: center; gap: 10px; text-align: center; }
.cn-pair canvas { image-rendering: pixelated; border-radius: 8px; background: #fff;
  border: 1px solid var(--border); }
.cn-status { font-size: 14px; color: var(--ink); font-weight: 600; }
.cn-hint { font-size: 13.5px; color: var(--ink-soft); max-width: 42ch; line-height: 1.5; }
.cn-link { font-family: var(--mono); font-size: 12px; word-break: break-all; color: var(--accent); }
.cn-wait { font-size: 12.5px; color: var(--ink-faint); }
.cn-pair-actions { display: flex; gap: 8px; margin-top: 4px; }
.cn-pair.ok .cn-status { color: var(--ok); }
.cn-pair.bad .cn-status { color: var(--danger); }
`;

/** Canvas geometry — module pixel size and the quiet-zone margin (in modules). */
const QR_PIXEL = 6;
const QR_MARGIN = 2;

/** A badge describing a channel's live state (the honest gate is `available`). */
function channelBadge(c: ChannelRow): HTMLElement {
  if (!c.available) return h("span", { class: "badge" }, "soon");
  if (c.running) {
    return h("span", { class: "badge ok" }, h("span", { class: "status-dot" }), "connected");
  }
  if (c.enabled && c.configured) return h("span", { class: "badge danger" }, "check token");
  if (c.configured) return h("span", { class: "badge" }, "disabled");
  return h("span", { class: "badge" }, "needs token");
}

/** A one-line, accurate next step for a channel (CLI is the trusted setup surface). */
function channelHint(c: ChannelRow): HTMLElement | null {
  if (!c.available) return h("span", { class: "muted" }, "handler coming soon");
  const hint = c.configured
    ? c.enabled
      ? `restart the daemon to apply, or check the token: vesper connections test ${c.id}`
      : `enable it: vesper connections enable ${c.id}`
    : `add a token: vesper connections set ${c.id}`;
  return h(
    "span",
    { class: "muted" },
    `${hint}  ·  `,
    h("a", { href: c.docsUrl, target: "_blank", rel: "noreferrer" }, "setup guide"),
  );
}

/** Paint a QR matrix onto a canvas: light background, dark filled squares per dark module. */
function drawQr(canvas: HTMLCanvasElement, m: QrMatrix): void {
  const dim = (m.size + QR_MARGIN * 2) * QR_PIXEL;
  canvas.width = dim;
  canvas.height = dim;
  const g = canvas.getContext("2d");
  if (g === null) return;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, dim, dim);
  g.fillStyle = "#0b0a14";
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.modules[y * m.size + x] !== true) continue;
      g.fillRect((x + QR_MARGIN) * QR_PIXEL, (y + QR_MARGIN) * QR_PIXEL, QR_PIXEL, QR_PIXEL);
    }
  }
}

/** Narrow an `unknown` JSON value to a {@link PairingUpdate}. */
function asPairingUpdate(value: unknown): PairingUpdate | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.status === "awaiting") {
    const p = v.prompt;
    if (typeof p !== "object" || p === null) return null;
    const prompt = p as Record<string, unknown>;
    if (typeof prompt.data !== "string" || typeof prompt.humanHint !== "string") return null;
    return {
      status: "awaiting",
      prompt: {
        kind: typeof prompt.kind === "string" ? prompt.kind : "link",
        data: prompt.data,
        humanHint: prompt.humanHint,
        expiresAt: typeof prompt.expiresAt === "number" ? prompt.expiresAt : 0,
      },
    };
  }
  if (v.status === "linked") {
    return {
      status: "linked",
      ...(typeof v.chatId === "string" ? { chatId: v.chatId } : {}),
      ...(typeof v.label === "string" ? { label: v.label } : {}),
    };
  }
  if (v.status === "error") {
    return { status: "error", reason: typeof v.reason === "string" ? v.reason : "pairing failed" };
  }
  if (v.status === "expired") return { status: "expired" };
  return null;
}

/**
 * Read a `ReadableStream` body as newline-delimited JSON, yielding one decoded
 * `PairingUpdate` per complete line. Tolerates frames split across chunks.
 */
async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<PairingUpdate, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value !== undefined) buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        const update = asPairingUpdate(JSON.parse(line) as unknown);
        if (update !== null) yield update;
      }
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    const update = asPairingUpdate(JSON.parse(tail) as unknown);
    if (update !== null) yield update;
  }
}

/**
 * Channels — the messaging surfaces (live, from `GET /api/connections`) and the MCP
 * catalog. Pairable + configured channels expose a scan-to-connect "Connect" card
 * that streams a QR code to link a chat from your phone. Tokens are still set with the
 * `vesper connections` CLI (stdin-only) — the browser never accepts a credential.
 */
export const channelsSection: SectionModule = {
  id: "channels",
  title: "Channels",
  group: "vesper",
  glyph: ICONS.channels,
  async mount(host: HTMLElement, ctx: SectionContext) {
    injectStyle(STYLE_ID, STYLE);
    host.append(sectionHeader("Channels", "Where Vesper can send and receive messages."));

    const messaging = h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Messaging channels"),
    );
    host.append(messaging);

    // The single currently-open pairing card (only one at a time). Tracked across
    // re-renders so a refresh tears the old card down before rebuilding the list.
    let openCard: HTMLElement | null = null;
    let cancelOpen: (() => void) | null = null;

    /** True once the section has been swapped out of the DOM — stop any live stream. */
    const unmounted = (): boolean => !host.isConnected;

    function closeCard(): void {
      cancelOpen?.();
      cancelOpen = null;
      openCard?.remove();
      openCard = null;
    }

    /** (Re)load the channel list into the messaging panel — the badge-flip after a link. */
    async function refresh(): Promise<void> {
      closeCard();
      // Keep the panel title; drop the rows below it.
      while (messaging.childNodes.length > 1) messaging.lastChild?.remove();
      try {
        const rows = await ctx.api.getJson<ChannelRow[]>("/api/connections");
        if (rows.length === 0) {
          messaging.append(h("p", { class: "muted" }, "No channels are wired yet."));
          return;
        }
        for (const c of rows) messaging.append(renderRow(c));
      } catch (err) {
        messaging.append(
          h(
            "p",
            { class: "muted" },
            err instanceof Error ? err.message : "could not load channels",
          ),
        );
      }
    }

    /** One channel row, with a Connect button + inline pairing card when pairable. */
    function renderRow(c: ChannelRow): HTMLElement {
      const head = h(
        "div",
        { class: "cn-head" },
        h("span", { class: "k" }, c.displayName),
        channelBadge(c),
      );

      const row = h("div", { class: "kv cn-row" }, head);

      if (c.pairable && c.configured) {
        const connect = h(
          "button",
          { class: "btn", type: "button", "aria-label": `Connect ${c.displayName}` },
          "Connect",
        );
        connect.addEventListener("click", () => openPairing(c, row));
        head.append(connect);
      }

      const hint = channelHint(c);
      if (hint !== null) row.append(hint);
      return row;
    }

    /** Open (or re-open) the inline pairing card for a channel under its row. */
    function openPairing(c: ChannelRow, row: HTMLElement): void {
      closeCard();

      const canvas = h("canvas", { width: 132, height: 132 });
      const status = h("div", { class: "cn-status" }, "Starting…");
      const hint = h("p", { class: "cn-hint" });
      const link = h("a", { class: "cn-link", target: "_blank", rel: "noreferrer" });
      const wait = h("div", { class: "cn-wait" });
      const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
      const actions = h("div", { class: "cn-pair-actions" }, cancel);

      const card = h(
        "div",
        { class: "cn-pair", role: "group", "aria-label": `Pair ${c.displayName}` },
        canvas,
        status,
        hint,
        link,
        wait,
        actions,
      );
      row.append(card);
      openCard = card;

      const controller = new AbortController();
      cancelOpen = () => controller.abort();
      cancel.addEventListener("click", () => closeCard());

      void runPairing(c, { card, canvas, status, hint, link, wait, actions, cancel, controller });
    }

    interface PairingUi {
      readonly card: HTMLElement;
      readonly canvas: HTMLCanvasElement;
      readonly status: HTMLElement;
      readonly hint: HTMLElement;
      readonly link: HTMLAnchorElement;
      readonly wait: HTMLElement;
      readonly actions: HTMLElement;
      readonly cancel: HTMLElement;
      readonly controller: AbortController;
    }

    /** Render a terminal failure with a "Try again" button that re-opens the flow. */
    function showFailure(c: ChannelRow, row: HTMLElement, ui: PairingUi, message: string): void {
      ui.card.classList.remove("ok");
      ui.card.classList.add("bad");
      ui.canvas.style.display = "none";
      ui.status.textContent = message;
      ui.hint.textContent = "";
      ui.link.removeAttribute("href");
      ui.link.textContent = "";
      ui.wait.textContent = "";
      const retry = h("button", { class: "btn primary", type: "button" }, "Try again");
      retry.addEventListener("click", () => openPairing(c, row));
      ui.actions.replaceChildren(retry, ui.cancel);
    }

    /** Drive one pairing session: stream updates, draw the QR, flip on link/failure. */
    async function runPairing(c: ChannelRow, ui: PairingUi): Promise<void> {
      const row = ui.card.parentElement;
      try {
        const res = await fetch(`/api/connections/${encodeURIComponent(c.id)}/pair`, {
          method: "POST",
          signal: ui.controller.signal,
        });
        if (!res.ok || res.body === null) {
          const text = await res.text().catch(() => "");
          if (row !== null)
            showFailure(
              c,
              row,
              ui,
              text.trim().length > 0 ? text.trim() : "Pairing is not available.",
            );
          return;
        }

        for await (const update of readNdjson(res.body)) {
          if (unmounted() || !ui.card.isConnected) return;

          if (update.status === "awaiting") {
            ui.status.textContent = "Scan to connect";
            ui.hint.textContent = update.prompt.humanHint;
            ui.link.href = update.prompt.data;
            ui.link.textContent = update.prompt.data;
            ui.wait.textContent = "Waiting for you to scan…";
            try {
              const matrix = (await ctx.api.getJson<QrMatrix>(
                `/api/qr?data=${encodeURIComponent(update.prompt.data)}`,
              )) satisfies QrMatrix;
              if (!ui.card.isConnected) return;
              ui.canvas.style.display = "";
              drawQr(ui.canvas, matrix);
            } catch {
              // Code unavailable — the clickable link still gets the user there.
              ui.canvas.style.display = "none";
            }
            continue;
          }

          if (update.status === "linked") {
            ui.card.classList.add("ok");
            ui.canvas.style.display = "none";
            ui.status.textContent = update.chatId
              ? `Connected! (chat ${update.chatId})`
              : "Connected!";
            ui.hint.textContent = "";
            ui.link.removeAttribute("href");
            ui.link.textContent = "";
            ui.wait.textContent = "";
            ui.actions.replaceChildren();
            ctx.toast(`${c.displayName} connected`);
            setTimeout(() => {
              if (!unmounted()) void refresh();
            }, 1500);
            return;
          }

          if (update.status === "expired") {
            if (row !== null) showFailure(c, row, ui, "This code expired. Try again.");
            return;
          }

          // status === "error"
          if (row !== null) showFailure(c, row, ui, update.reason);
          return;
        }
        // Stream ended without a terminal frame.
        if (!unmounted() && ui.card.isConnected && row !== null) {
          showFailure(c, row, ui, "Pairing ended unexpectedly. Try again.");
        }
      } catch (err) {
        // An abort on Cancel is expected — swallow it.
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (unmounted() || !ui.card.isConnected || row === null) return;
        showFailure(c, row, ui, err instanceof Error ? err.message : "Pairing failed.");
      }
    }

    ctx.onCleanup(() => closeCard());

    await refresh();

    const mcp = h("div", { class: "panel" }, h("div", { class: "panel-title" }, "MCP servers"));
    const chips = h("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
    for (const name of MCP) chips.append(h("span", { class: "badge" }, name));
    mcp.append(chips);
    host.append(mcp);

    host.append(
      h(
        "p",
        { class: "muted", style: "margin-top:16px" },
        "Channel tokens are set with the vesper CLI (read from stdin, stored in your OS keychain). " +
          "Connect Telegram to reach the chatbot from your phone.",
      ),
    );
  },
};
