/// <reference lib="dom" />
import { createApiClient } from "./shell/api.ts";
import type { RunRow, StatusResponse } from "./shell/contracts.ts";

/** Minimal shape of the Tauri global bridge (present only inside the native app). */
interface TauriBridge {
  readonly core?: { invoke(cmd: string): Promise<unknown> };
}
function bridge(): TauriBridge | undefined {
  return (window as unknown as { __TAURI__?: TauriBridge }).__TAURI__;
}
/** Invoke a native command if running inside the app; no-op in a plain browser. */
function invoke(cmd: string): void {
  void bridge()?.core?.invoke(cmd);
}

const MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.8 6.4L20 12l-6.2 1.8L12 22l-1.8-8.2L4 12l6.2-3.6L12 2z" fill="currentColor"/></svg>';

const PANEL_CSS = `
  body[data-mode="panel"] { background: var(--bg); overflow: hidden; }
  body[data-mode="panel"] .titlebar, body[data-mode="panel"] .app { display: none !important; }
  .panel { position: fixed; inset: 0; display: flex; flex-direction: column; padding: 16px; gap: 12px; }
  .pn-head { display: flex; align-items: center; gap: 10px; }
  .pn-mark { width: 22px; height: 22px; color: var(--accent); display: grid; place-items: center; }
  .pn-mark svg { width: 22px; height: 22px; }
  .pn-title { font-size: 16px; font-weight: 700; }
  .pn-state { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-soft); }
  .pn-state .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .pn-card { background: var(--surface); border: 1px solid var(--border); border-radius: 13px; -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur); padding: 13px 15px; }
  .pn-kv { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 13.5px; border-bottom: 1px solid var(--border); }
  .pn-kv:last-child { border-bottom: none; }
  .pn-kv .k { color: var(--ink-soft); } .pn-kv .v { color: var(--ink); font-variant-numeric: tabular-nums; }
  .pn-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-soft); font-weight: 700; margin: 2px 2px 8px; }
  .pn-runs { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 7px; }
  .pn-run { display: flex; align-items: center; gap: 9px; font-size: 13px; }
  .pn-run .d { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ink-faint); }
  .pn-run .d.ok { background: var(--ok); } .pn-run .d.error { background: var(--danger); }
  .pn-run .nm { color: var(--ink); } .pn-run .ago { margin-left: auto; color: var(--ink-faint); font-size: 12px; }
  .pn-empty { color: var(--ink-faint); font-style: italic; font-size: 13px; padding: 6px 0; }
  .pn-actions { display: flex; gap: 9px; }
  .pn-actions .btn { flex: 1; min-height: 38px; }
`;

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * The menu-bar popover — a compact quick-glance of Vesper: daemon status, default
 * CLI, run/session counts, recent activity, and (inside the native app) "Open Vesper"
 * + "Quit". Loaded at `/?panel=1` in a small borderless tray window.
 */
export function mountPanel(): void {
  document.body.dataset.mode = "panel";
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  document.head.append(style);

  const root = document.createElement("div");
  root.className = "panel";
  root.innerHTML = `
    <div class="pn-head">
      <span class="pn-mark">${MARK}</span>
      <span class="pn-title">Vesper</span>
      <span class="pn-state" id="pn-state"><span class="status-dot" style="background:var(--ink-faint)"></span>connecting…</span>
    </div>
    <div class="pn-card" id="pn-stats"></div>
    <div>
      <div class="pn-section-title">Recent activity</div>
      <div class="pn-runs" id="pn-runs"></div>
    </div>
    <div class="pn-actions" id="pn-actions"></div>
  `;
  document.body.append(root);

  const stateEl = root.querySelector<HTMLElement>("#pn-state");
  const statsEl = root.querySelector<HTMLElement>("#pn-stats");
  const runsEl = root.querySelector<HTMLElement>("#pn-runs");
  const actionsEl = root.querySelector<HTMLElement>("#pn-actions");
  const api = createApiClient();

  // Native actions only when the Tauri bridge is present (hidden in a dev browser).
  if (bridge() !== undefined && actionsEl !== null) {
    const open = document.createElement("button");
    open.className = "btn primary";
    open.textContent = "Open Vesper";
    open.addEventListener("click", () => invoke("open_main"));
    const quit = document.createElement("button");
    quit.className = "btn";
    quit.textContent = "Quit";
    quit.addEventListener("click", () => invoke("quit_app"));
    actionsEl.append(open, quit);
  } else if (actionsEl !== null) {
    actionsEl.innerHTML = `<span class="pn-empty">Open the Vesper app for menu-bar actions.</span>`;
  }

  const kv = (k: string, v: string): string =>
    `<div class="pn-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  const refresh = async (): Promise<void> => {
    try {
      const s = await api.getJson<StatusResponse>("/api/status");
      if (stateEl !== null) {
        stateEl.innerHTML = `<span class="status-dot" style="background:var(--ok)"></span>online`;
      }
      if (statsEl !== null) {
        statsEl.innerHTML =
          kv("Daemon", `v${s.version}`) +
          kv("Helper CLI", s.defaultCli ?? "none") +
          kv("Runs", String(s.runs)) +
          kv("Chats", String(s.sessions));
      }
    } catch {
      if (stateEl !== null) {
        stateEl.innerHTML = `<span class="status-dot" style="background:var(--danger)"></span>offline`;
      }
    }
    try {
      const runs = await api.getJson<RunRow[]>("/api/runs?limit=6");
      if (runsEl !== null) {
        if (runs.length === 0) {
          runsEl.innerHTML = `<div class="pn-empty">No runs yet.</div>`;
        } else {
          runsEl.replaceChildren();
          for (const r of runs) {
            const row = document.createElement("div");
            row.className = "pn-run";
            const cls = r.status === "ok" ? "ok" : r.status === "error" ? "error" : "";
            row.innerHTML = `<span class="d ${cls}"></span><span class="nm">${r.pipeline}</span><span class="ago">${ago(r.ts)}</span>`;
            runsEl.append(row);
          }
        }
      }
    } catch {
      // keep prior render.
    }
  };

  void refresh();
  const timer = window.setInterval(() => void refresh(), 4000);
  window.addEventListener("beforeunload", () => window.clearInterval(timer));
}
