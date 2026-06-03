/// <reference lib="dom" />
import type { PresenceInfo } from "../../world/types.ts";
import type { RunRow, StatusResponse } from "../shell/contracts.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function badge(ok: boolean, label: string): HTMLElement {
  return h(
    "span",
    { class: `badge ${ok ? "ok" : "danger"}` },
    h("span", { class: "status-dot" }),
    label,
  );
}

/**
 * Diagnostics — helper-CLI probe status, recent runs, and the agents running on this
 * machine right now (the relocated presence/echo feature — moved off the home).
 */
export const diagnosticsSection: SectionModule = {
  id: "diagnostics",
  title: "Diagnostics",
  group: "computer",
  glyph: ICONS.diagnostics,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(sectionHeader("Diagnostics", "Health of Vesper and the agents on this machine."));

    const cliPanel = h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Helper CLIs"),
    );
    const presencePanel = h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Agents running now"),
    );
    const runsPanel = h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Recent runs"),
    );
    host.append(h("div", { class: "grid2" }, cliPanel, presencePanel), runsPanel);

    const [status, presence, runs] = await Promise.all([
      ctx.api.getJson<StatusResponse>("/api/status").catch(() => null),
      ctx.api.getJson<PresenceInfo[]>("/api/presence").catch(() => [] as PresenceInfo[]),
      ctx.api.getJson<RunRow[]>("/api/runs?limit=12").catch(() => [] as RunRow[]),
    ]);

    if (status === null || status.clis.length === 0) {
      cliPanel.append(h("p", { class: "empty-note" }, "No helper CLIs detected on PATH."));
    } else {
      for (const c of status.clis) {
        cliPanel.append(
          h("div", { class: "kv" }, h("span", { class: "k" }, c.name), badge(c.ok, c.status)),
        );
      }
    }

    if (presence.length === 0) {
      presencePanel.append(
        h("p", { class: "empty-note" }, "No external agents detected right now."),
      );
    } else {
      for (const p of presence) {
        presencePanel.append(
          h(
            "div",
            { class: "kv" },
            h("span", { class: "k" }, `${p.label} · ${p.kind}`),
            h("span", { class: "v" }, `${p.procCount}× · up ${p.since}`),
          ),
        );
      }
    }

    if (runs.length === 0) {
      runsPanel.append(h("p", { class: "empty-note" }, "No runs recorded yet."));
    } else {
      for (const r of runs) {
        const ok = r.status === "ok";
        runsPanel.append(
          h(
            "div",
            { class: "kv" },
            h(
              "span",
              { class: "k" },
              badge(ok, r.status),
              h("span", { style: "margin-left:10px;color:var(--ink)" }, r.pipeline),
            ),
            h("span", { class: "v" }, timeAgo(r.ts)),
          ),
        );
      }
    }
  },
};
