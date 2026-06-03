/// <reference lib="dom" />
import type { StatusResponse } from "../shell/contracts.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";

/** Format a ms duration as a compact uptime (e.g. "1h 4m", "12s"). */
function uptime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ${m % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function kv(k: string, v: Node | string, mono = false): HTMLElement {
  const value = typeof v === "string" ? h("span", { class: mono ? "v mono" : "v" }, v) : v;
  return h("div", { class: "kv" }, h("span", { class: "k" }, k), value);
}

function statusBadge(ok: boolean, label: string): HTMLElement {
  return h(
    "span",
    { class: `badge ${ok ? "ok" : "danger"}` },
    h("span", { class: "status-dot" }),
    label,
  );
}

/**
 * Runtime — the daemon/IPC/version/uptime panel (the Vesper analogue of OpenClaw's
 * Gateway/Server view). Reads `GET /api/status`; refreshes every 4s while mounted.
 */
export const runtimeSection: SectionModule = {
  id: "runtime",
  title: "Runtime",
  group: "computer",
  glyph: ICONS.runtime,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(sectionHeader("Runtime", "The local Vesper daemon hosting this UI."));
    const body = h("div", { class: "grid2" });
    host.append(body);

    const render = (s: StatusResponse): void => {
      const cliOnline = s.clis.find((c) => c.name === s.defaultCli)?.ok ?? false;
      body.replaceChildren(
        h(
          "div",
          { class: "panel" },
          h("div", { class: "panel-title" }, "Daemon"),
          kv("Status", statusBadge(true, "connected")),
          kv("Version", `v${s.version}`, true),
          kv("Uptime", uptime(s.uptimeMs)),
          kv("UI port", String(s.uiPort), true),
          kv("IPC socket", s.socket, true),
        ),
        h(
          "div",
          { class: "panel" },
          h("div", { class: "panel-title" }, "Helper CLI"),
          kv("Default", s.defaultCli ?? "none selected"),
          kv("Probe", statusBadge(cliOnline, cliOnline ? "ok" : "not ready")),
          kv("Installed", String(s.clis.length)),
          h("div", { class: "panel-title", style: "margin-top:16px" }, "Storage"),
          kv("Runs recorded", String(s.runs)),
          kv("Chat sessions", String(s.sessions)),
        ),
      );
    };

    const error = (msg: string): void => {
      body.replaceChildren(
        h(
          "div",
          { class: "panel" },
          h("div", { class: "panel-title" }, "Daemon"),
          kv("Status", statusBadge(false, "unreachable")),
          h("p", { class: "muted" }, msg),
        ),
      );
    };

    const refresh = async (): Promise<void> => {
      try {
        render(await ctx.api.getJson<StatusResponse>("/api/status"));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    };

    await refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    ctx.onCleanup(() => window.clearInterval(timer));
  },
};
