/// <reference lib="dom" />
import type { StatusResponse } from "../shell/contracts.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";

/** A label:value row matching the shared `.kv` primitive. */
function kv(k: string, v: Node | string): HTMLElement {
  const value = typeof v === "string" ? h("span", { class: "v" }, v) : v;
  return h("div", { class: "kv" }, h("span", { class: "k" }, k), value);
}

/** ok = green dot badge, otherwise a red "not ready" badge. */
function statusBadge(ok: boolean, label: string): HTMLElement {
  return h(
    "span",
    { class: `badge ${ok ? "ok" : "danger"}` },
    h("span", { class: "status-dot" }),
    label,
  );
}

/**
 * Helper CLIs — the installed coding CLIs Vesper orchestrates (`claude`, `opencode`,
 * `codex`, `gemini`). Reads `GET /api/status` and lists each detected CLI with probe status.
 */
export const cliSection: SectionModule = {
  id: "cli",
  title: "Helper CLIs",
  group: "computer",
  glyph: ICONS.cli,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(
      sectionHeader("Helper CLIs", "The coding CLIs on this machine that Vesper orchestrates."),
    );
    const body = h("div", { class: "panel" });
    host.append(body);

    try {
      const s = await ctx.api.getJson<StatusResponse>("/api/status");
      const rows: Node[] = [
        h("div", { class: "panel-title" }, "Detected"),
        kv("Default", s.defaultCli ?? "none selected"),
      ];
      if (s.clis.length === 0) {
        rows.push(h("p", { class: "empty-note" }, "No helper CLIs detected on PATH."));
      } else {
        for (const c of s.clis) {
          rows.push(kv(c.name, statusBadge(c.ok, c.ok ? "ok" : "not ready")));
        }
      }
      body.replaceChildren(...rows);
    } catch (err) {
      body.replaceChildren(
        h("div", { class: "panel-title" }, "Detected"),
        h("p", { class: "empty-note" }, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
