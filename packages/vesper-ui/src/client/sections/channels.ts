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
  /** Pairs with no prior token (device-link: WhatsApp-personal, Signal) — Connect shows at once. */
  readonly selfPairing: boolean;
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
.cn-token { margin-top: 10px; border: 1px solid var(--border-strong); border-radius: 12px;
  background: var(--surface-2); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.cn-token-row { display: flex; gap: 8px; align-items: center; }
.cn-token-row .field { flex: 1; }
.cn-token-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  font-size: 12.5px; }
.cn-token-status.bad { color: var(--danger); }
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
  // Device-link channels need no token — pairing IS the setup.
  if (c.selfPairing) return h("span", { class: "badge" }, "ready to connect");
  return h("span", { class: "badge" }, "needs token");
}

/** A one-line, accurate next step that matches the row's buttons (no longer CLI-only). */
function channelHint(c: ChannelRow): HTMLElement | null {
  if (!c.available) return h("span", { class: "muted" }, "handler coming soon");
  if (c.running) return null; // connected — the badge already says it
  if (c.selfPairing && !c.configured) {
    return h(
      "span",
      { class: "muted" },
      "Press Connect and scan with your phone — no token needed.",
    );
  }
  if (c.configured) {
    return h(
      "span",
      { class: "muted" },
      c.enabled
        ? "Saved — restart the daemon to apply."
        : `Enable it: vesper connections enable ${c.id}`,
    );
  }
  // Token channel with no credential yet — the "Enter token" button is right here.
  return h(
    "span",
    { class: "muted" },
    'Press "Enter token" to connect  ·  ',
    h("a", { href: c.docsUrl, target: "_blank", rel: "noreferrer" }, "where do I find it?"),
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
 * A streamed update from `POST /api/connections/:id/setup` (auto-onboarding). `working`
 * may repeat; `configured` / `awaiting_user` / `error` are terminal. Mirrors core
 * `SetupUpdate` — declared locally to keep core out of the browser bundle.
 */
type SetupUpdate =
  | { readonly status: "working"; readonly message: string }
  | { readonly status: "configured" }
  | { readonly status: "awaiting_user"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

/** Read a `ReadableStream` body as newline-delimited text lines (frames may split chunks). */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
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
      if (line.length > 0) yield line;
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  const tail = buffer.trim();
  if (tail.length > 0) yield tail;
}

/** Read a pairing ndjson stream, yielding one decoded `PairingUpdate` per line. */
async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<PairingUpdate, void, void> {
  for await (const line of readLines(body)) {
    const update = asPairingUpdate(JSON.parse(line) as unknown);
    if (update !== null) yield update;
  }
}

/** Narrow an `unknown` JSON value to a {@link SetupUpdate}. */
function asSetupUpdate(value: unknown): SetupUpdate | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.status === "working") {
    return { status: "working", message: typeof v.message === "string" ? v.message : "Working…" };
  }
  if (v.status === "configured") return { status: "configured" };
  if (v.status === "awaiting_user") {
    return {
      status: "awaiting_user",
      reason: typeof v.reason === "string" ? v.reason : "Finish setup manually.",
    };
  }
  if (v.status === "error") {
    return { status: "error", reason: typeof v.reason === "string" ? v.reason : "setup failed" };
  }
  return null;
}

/**
 * Channels — the messaging surfaces (live, from `GET /api/connections`) and the MCP
 * catalog. One "Connect" button per channel: device-link channels stream a QR to scan;
 * a not-yet-configured token channel runs auto-onboarding (Vesper drives your CLI's
 * browser to mint the token), falling back to an inline manual token field when that
 * cannot finish. Tokens entered here go straight to your OS keychain.
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

      // One "Connect" button, routed by channel kind:
      //  - device-link OR already-configured pairable -> QR/link pairing (capture chat id);
      //  - pairable token channel with NO token yet (Telegram/Discord) -> auto-onboarding
      //    (drive the CLI's browser to mint the token, then it becomes pairable).
      const canPair = c.available && c.pairable && (c.selfPairing || c.configured);
      const canSetup = c.available && c.pairable && !c.selfPairing && !c.configured;
      if (canPair || canSetup) {
        const connect = h(
          "button",
          { class: "btn", type: "button", "aria-label": `Connect ${c.displayName}` },
          "Connect",
        );
        connect.addEventListener("click", () =>
          canPair ? openPairing(c, row) : openSetup(c, row),
        );
        head.append(connect);
      }

      // Manual token entry — the always-available fallback (and primary path for the
      // send-only WhatsApp Cloud channel). Token channels get a password field for the vault.
      if (c.available && !c.selfPairing) {
        const enter = h(
          "button",
          { class: "btn", type: "button" },
          c.configured ? "Update token" : "Enter token",
        );
        enter.addEventListener("click", () => toggleTokenForm(c, row));
        head.append(enter);
      }

      const hint = channelHint(c);
      if (hint !== null) row.append(hint);
      return row;
    }

    /** Toggle the inline manual-token form under a channel row (one at a time per row). */
    function toggleTokenForm(c: ChannelRow, row: HTMLElement): void {
      const existing = row.querySelector(".cn-token");
      if (existing !== null) {
        existing.remove();
        return;
      }
      row.append(buildTokenForm(c));
    }

    /** Build the inline manual-token form: a password field + Save, posting to the vault. */
    function buildTokenForm(c: ChannelRow): HTMLElement {
      const input = h("input", {
        class: "field",
        type: "password",
        autocomplete: "off",
        spellcheck: "false",
        placeholder: `${c.displayName} token`,
        "aria-label": `${c.displayName} token`,
      });
      const save = h("button", { class: "btn primary", type: "button" }, "Save");
      const status = h("span", { class: "cn-token-status muted" });
      const guide = h(
        "a",
        { href: c.docsUrl, target: "_blank", rel: "noreferrer", class: "muted" },
        "where do I find this?",
      );
      const form = h(
        "div",
        { class: "cn-token", role: "group", "aria-label": `${c.displayName} token` },
        h("div", { class: "cn-token-row" }, input, save),
        h("div", { class: "cn-token-foot" }, guide, status),
      );

      const submit = async (): Promise<void> => {
        const token = input.value.trim();
        if (token.length === 0) {
          status.classList.add("bad");
          status.textContent = "Enter a token first.";
          return;
        }
        save.disabled = true;
        status.classList.remove("bad");
        status.textContent = "Saving…";
        try {
          await ctx.api.postJson(`/api/connections/${encodeURIComponent(c.id)}/token`, { token });
          input.value = "";
          ctx.toast(`${c.displayName} token saved`);
          await refresh();
        } catch (err) {
          save.disabled = false;
          status.classList.add("bad");
          status.textContent = err instanceof Error ? err.message : "Could not save token.";
        }
      };
      save.addEventListener("click", () => void submit());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void submit();
      });
      setTimeout(() => input.focus(), 0);
      return form;
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

    // ── Auto-onboarding (token channels: Telegram, Discord) ─────────────────
    interface SetupUi {
      readonly card: HTMLElement;
      readonly status: HTMLElement;
      readonly hint: HTMLElement;
      readonly actions: HTMLElement;
      readonly cancel: HTMLElement;
      readonly controller: AbortController;
    }

    /** Open the inline auto-onboarding card under a channel row (drives the CLI's browser). */
    function openSetup(c: ChannelRow, row: HTMLElement): void {
      closeCard();
      const status = h("div", { class: "cn-status" }, "Starting…");
      const hint = h(
        "p",
        { class: "cn-hint" },
        `Vesper is opening a browser to set up ${c.displayName} for you. This can take a minute.`,
      );
      const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
      const actions = h("div", { class: "cn-pair-actions" }, cancel);
      const card = h(
        "div",
        { class: "cn-pair", role: "group", "aria-label": `Set up ${c.displayName}` },
        status,
        hint,
        actions,
      );
      row.append(card);
      openCard = card;

      const controller = new AbortController();
      cancelOpen = () => controller.abort();
      cancel.addEventListener("click", () => closeCard());
      void runSetup(c, row, { card, status, hint, actions, cancel, controller });
    }

    /** Terminal setup failure: keep the user moving with "Try again" + the manual field. */
    function setupFailed(c: ChannelRow, row: HTMLElement, ui: SetupUi, message: string): void {
      ui.card.classList.add("bad");
      ui.status.textContent = message;
      ui.hint.textContent = "";
      const retry = h("button", { class: "btn", type: "button" }, "Try again");
      retry.addEventListener("click", () => openSetup(c, row));
      const manual = h("button", { class: "btn primary", type: "button" }, "Enter token");
      manual.addEventListener("click", () => {
        closeCard();
        toggleTokenForm(c, row);
      });
      ui.actions.replaceChildren(retry, manual, ui.cancel);
    }

    /** Drive one setup session: stream progress, then succeed, fall back, or fail. */
    async function runSetup(c: ChannelRow, row: HTMLElement, ui: SetupUi): Promise<void> {
      try {
        const res = await fetch(`/api/connections/${encodeURIComponent(c.id)}/setup`, {
          method: "POST",
          signal: ui.controller.signal,
        });
        if (!res.ok || res.body === null) {
          const text = await res.text().catch(() => "");
          setupFailed(c, row, ui, text.trim().length > 0 ? text.trim() : "Setup is not available.");
          return;
        }
        for await (const line of readLines(res.body)) {
          if (unmounted() || !ui.card.isConnected) return;
          const u = asSetupUpdate(JSON.parse(line) as unknown);
          if (u === null) continue;

          if (u.status === "working") {
            ui.status.textContent = u.message;
            continue;
          }
          if (u.status === "configured") {
            ui.card.classList.add("ok");
            ui.status.textContent = `${c.displayName} is set up!`;
            ui.hint.textContent = "";
            ui.actions.replaceChildren();
            ctx.toast(`${c.displayName} connected`);
            setTimeout(() => {
              if (!unmounted()) void refresh();
            }, 1500);
            return;
          }
          if (u.status === "awaiting_user") {
            // Automation could not finish — show the reason + the manual token field inline.
            ui.status.textContent = "Almost there";
            ui.hint.textContent = u.reason;
            ui.actions.replaceChildren(ui.cancel);
            ui.card.append(buildTokenForm(c));
            return;
          }
          setupFailed(c, row, ui, u.reason);
          return;
        }
        if (!unmounted() && ui.card.isConnected) {
          setupFailed(c, row, ui, "Setup ended unexpectedly. Try again.");
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (unmounted() || !ui.card.isConnected) return;
        setupFailed(c, row, ui, err instanceof Error ? err.message : "Setup failed.");
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
        "Tokens you enter here are stored in your OS keychain (never shown again). WhatsApp and " +
          "Signal need no token — just press Connect and scan. The vesper CLI can also set tokens.",
      ),
    );
  },
};
