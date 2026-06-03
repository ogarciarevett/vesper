/// <reference lib="dom" />
import { mountPanel } from "./panel.ts";
import { ALL_SECTIONS } from "./sections/index.ts";
import { createApiClient } from "./shell/api.ts";
import { SectionRouter } from "./shell/router.ts";
import type { LiveBus, LiveMessage } from "./shell/section.ts";
import { renderSidebar } from "./shell/sidebar.ts";
import { bootTheme } from "./shell/themes.ts";
import { mountTitlebar } from "./shell/titlebar.ts";

// Resolve and apply the chrome palette (dark glass by default).
bootTheme();

// Menu-bar popover mode: a small borderless tray window loads `/?panel=1`. Render the
// compact quick-glance panel instead of the full app shell, and stop.
if (new URLSearchParams(window.location.search).get("panel") === "1") {
  mountPanel();
} else {
  bootShell();
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

/** Boot the full desktop shell (titlebar + sidebar + section router + live socket). */
function bootShell(): void {
  // Reserve the macOS traffic-light inset only inside the native (Tauri) mac shell,
  // where the overlay titlebar floats the lights over our custom titlebar.
  const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  const isMac = /Mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent);
  if (isTauri && isMac) document.body.classList.add("native-mac");

  const host = el("section-host");
  const nav = el("nav");
  const titlebar = el("titlebar");
  const toastEl = el("toast");

  // ── Shared toast ────────────────────────────────────────────────────────────
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (message: string): void => {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
  };

  // ── Live channel (one socket, fanned out to the active section) ────────────
  const liveHandlers = new Set<(msg: LiveMessage) => void>();
  const liveBus: LiveBus = {
    add: (handler) => void liveHandlers.add(handler),
    remove: (handler) => void liveHandlers.delete(handler),
    emit: (msg) => {
      for (const handler of liveHandlers) {
        try {
          handler(msg);
        } catch {
          // a section's live handler must not break the channel.
        }
      }
    },
  };

  let socket: WebSocket | null = null;
  const wsSend = (payload: Record<string, unknown>): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(payload));
  };
  const connectLive = (): void => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/live`);
    socket = ws;
    ws.addEventListener("open", () => {
      // Tell sections to (re)subscribe + re-backfill — covers the first connect and
      // every reconnect (daemon restart) without a second transport.
      liveBus.emit({ type: "socket:open" });
    });
    ws.addEventListener("message", (ev) => {
      try {
        liveBus.emit(JSON.parse(String(ev.data)) as LiveMessage);
      } catch {
        // non-JSON frame — ignore.
      }
    });
    ws.addEventListener("close", () => {
      socket = null;
      setTimeout(connectLive, 1500);
    });
  };

  // ── Boot the shell ─────────────────────────────────────────────────────────
  const api = createApiClient();
  let sidebar: { setActive: (id: string) => void } | null = null;
  const router = new SectionRouter(host, { api, toast, wsSend }, liveBus, (id) =>
    sidebar?.setActive(id),
  );
  for (const section of ALL_SECTIONS) router.register(section);

  sidebar = renderSidebar(nav, router.list(), (id) => void router.navigate(id));
  mountTitlebar(titlebar, {
    api,
    sections: router.list(),
    onNavigate: (id) => void router.navigate(id),
  });

  router.start();
  connectLive();
}
