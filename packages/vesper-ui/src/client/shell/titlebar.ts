/// <reference lib="dom" />

import type { StatusResponse } from "./contracts.ts";
import { DOT } from "./icons.ts";
import type { ApiClient } from "./section.ts";

interface TitlebarDeps {
  readonly api: ApiClient;
}

/** Vesper wordmark glyph (four-point sparkle — matches the brand accent). */
const MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.8 6.4L20 12l-6.2 1.8L12 22l-1.8-8.2L4 12l6.2-3.6L12 2z" fill="currentColor"/></svg>';

/**
 * Mount the custom titlebar: brand mark + wordmark (left) and live status pills
 * (right) polled from `GET /api/status`. The bar is the window drag region (set in
 * CSS); its interactive children opt out via `.no-drag`.
 */
export function mountTitlebar(bar: HTMLElement, deps: TitlebarDeps): void {
  bar.replaceChildren();

  // Brand (left, after the macOS traffic-light inset reserved in CSS).
  const brand = document.createElement("div");
  brand.className = "tb-brand";
  brand.innerHTML = `<span class="tb-mark">${MARK}</span><span class="tb-word">Vesper</span>`;

  // Status pills (right).
  const pills = document.createElement("div");
  pills.className = "tb-pills no-drag";
  const modelPill = pill("model", "");
  modelPill.el.title = "orchestrator model";
  modelPill.el.hidden = true; // shown only when the daemon reports a model.
  const daemonPill = pill("daemon", "connecting…");
  const cliPill = pill("cli", "…");
  pills.append(modelPill.el, daemonPill.el, cliPill.el);

  bar.append(brand, pills);

  const refresh = async (): Promise<void> => {
    try {
      const s = await deps.api.getJson<StatusResponse>("/api/status");
      // Orchestrator model — present only when the daemon knows it (never a dead "—").
      if (typeof s.orchestratorModel === "string" && s.orchestratorModel.length > 0) {
        modelPill.el.hidden = false;
        modelPill.set(true, s.orchestratorModel);
      } else {
        modelPill.el.hidden = true;
      }
      daemonPill.set(true, `v${s.version}`);
      const cli = s.defaultCli ?? "no CLI";
      const cliOk = s.clis.find((c) => c.name === s.defaultCli)?.ok ?? false;
      cliPill.set(s.defaultCli !== null && cliOk, cli);
    } catch {
      modelPill.el.hidden = true;
      daemonPill.set(false, "offline");
      cliPill.set(false, "—");
    }
  };
  void refresh();
  const timer = window.setInterval(() => void refresh(), 5000);
  window.addEventListener("beforeunload", () => window.clearInterval(timer));
}

/** Build one status pill (a colored dot + a label). */
function pill(
  kind: string,
  initial: string,
): {
  el: HTMLElement;
  set: (ok: boolean, label: string) => void;
} {
  const el = document.createElement("span");
  el.className = "tb-pill";
  el.dataset.kind = kind;
  const dot = document.createElement("span");
  dot.className = "tb-dot";
  dot.innerHTML = DOT;
  const label = document.createElement("span");
  label.textContent = initial;
  el.append(dot, label);
  return {
    el,
    set(ok, text): void {
      el.dataset.ok = ok ? "true" : "false";
      label.textContent = text;
    },
  };
}
