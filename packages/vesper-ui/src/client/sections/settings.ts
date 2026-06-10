/// <reference lib="dom" />
import type { StatusResponse } from "../shell/contracts.ts";
import { ICONS } from "../shell/icons.ts";
import { h, type SectionContext, type SectionModule, sectionHeader } from "../shell/section.ts";
import { setTheme, THEMES } from "../shell/themes.ts";

/**
 * Settings — pick the app theme (re-skins instantly, persisted per browser), choose
 * the voice Vesper replies with (built-in local voice or ElevenLabs with the user's
 * own key — the key goes to the keychain, never back to the browser), and view the
 * read-only runtime config (default helper-CLI, UI port, version). Writing the rest
 * of the config back to `~/.vesper/config.json` is a follow-up (the privileged
 * approval-gated PUT); theme is client-side state so it needs no server write.
 */

/** GET /api/voice/config — the daemon's voice provider settings (no secrets). */
interface VoiceConfigResponse {
  readonly tts: "local" | "elevenlabs";
  readonly voiceId: string;
  readonly keyConfigured: boolean;
}
export const settingsSection: SectionModule = {
  id: "settings",
  title: "Settings",
  group: "computer",
  glyph: ICONS.settings,
  async mount(host: HTMLElement, ctx: SectionContext) {
    host.append(sectionHeader("Settings", "Appearance and runtime configuration."));

    // Appearance — theme picker.
    const active = document.body.dataset.theme ?? "dark";
    const swatches = h("div", { class: "theme-row" });
    const paint = (): void => {
      const cur = document.body.dataset.theme ?? "dark";
      for (const node of Array.from(swatches.children)) {
        (node as HTMLElement).setAttribute(
          "aria-current",
          (node as HTMLElement).dataset.theme === cur ? "true" : "false",
        );
      }
    };
    for (const t of THEMES) {
      const btn = h(
        "button",
        {
          type: "button",
          class: "theme-swatch",
          "data-theme": t.id,
          "aria-current": t.id === active ? "true" : "false",
          onclick: () => {
            setTheme(t.id);
            paint();
            ctx.toast(`Theme: ${t.displayName}`);
          },
        },
        h("span", { class: `sw-chip sw-${t.id}` }),
        h("span", null, t.displayName),
      );
      swatches.append(btn);
    }

    host.append(
      h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Appearance"), swatches),
    );

    // Voice — how spoken replies in the chat sound (provider + ElevenLabs key).
    const voice = h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Voice"));
    host.append(voice);
    try {
      const vc = await ctx.api.getJson<VoiceConfigResponse>("/api/voice/config");
      voice.append(voiceForm(ctx, vc));
    } catch {
      voice.append(
        h("p", { class: "muted" }, "Voice settings are unavailable (daemon not reachable)."),
      );
    }

    const cfg = h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Runtime"));
    host.append(cfg);
    try {
      const s = await ctx.api.getJson<StatusResponse>("/api/status");
      cfg.append(
        kv("Default helper CLI", s.defaultCli ?? "none selected"),
        kv("Installed CLIs", s.clis.length > 0 ? s.clis.map((c) => c.name).join(", ") : "none"),
        kv("UI port", String(s.uiPort), true),
        kv("Daemon version", `v${s.version}`, true),
      );
    } catch {
      cfg.append(
        h("p", { class: "muted" }, "Runtime config is unavailable (daemon not reachable)."),
      );
    }

    injectThemeStyle();
  },
};

/** The Voice card body: provider select + ElevenLabs voice id / key + save. */
function voiceForm(ctx: SectionContext, loaded: VoiceConfigResponse): HTMLElement {
  let current: { tts: string; voiceId: string } = { tts: loaded.tts, voiceId: loaded.voiceId };

  const provider = h("select", { class: "field", id: "voice-provider" });
  provider.append(
    h("option", { value: "local" }, "Computer voice (built-in, stays local)"),
    h("option", { value: "elevenlabs" }, "ElevenLabs (your own API key)"),
  );
  provider.value = loaded.tts;

  const voiceId = h("input", {
    class: "field",
    type: "text",
    id: "voice-id",
    value: loaded.voiceId,
  });
  const apiKey = h("input", {
    class: "field",
    type: "password",
    id: "voice-key",
    placeholder: "paste a new key",
    autocomplete: "off",
  });
  const keyHint = h(
    "p",
    { class: "voice-hint" },
    loaded.keyConfigured ? "A key is saved in your keychain." : "No key saved yet.",
  );

  const save = h("button", { class: "btn primary", type: "button" }, "Save voice settings");
  save.addEventListener("click", () => {
    const body: Record<string, string> = {};
    if (provider.value !== current.tts) body.tts = provider.value;
    if (voiceId.value.trim() !== current.voiceId) body.voiceId = voiceId.value.trim();
    if (apiKey.value.length > 0) body.apiKey = apiKey.value;
    if (Object.keys(body).length === 0) {
      ctx.toast("Nothing changed yet");
      return;
    }
    save.disabled = true;
    void (async () => {
      try {
        const res = await ctx.api.postJson<{ ok?: boolean; keyConfigured?: boolean }>(
          "/api/voice/config",
          body,
        );
        if (res.ok !== true) throw new Error("could not save voice settings");
        current = {
          tts: typeof body.tts === "string" ? body.tts : current.tts,
          voiceId: typeof body.voiceId === "string" ? body.voiceId : current.voiceId,
        };
        apiKey.value = ""; // the key is never kept (or echoed) in the browser.
        keyHint.textContent =
          res.keyConfigured === true ? "A key is saved in your keychain." : "No key saved yet.";
        ctx.toast("Voice settings saved");
      } catch (err) {
        ctx.toast(err instanceof Error ? err.message : "could not save voice settings");
      } finally {
        save.disabled = false;
      }
    })();
  });

  return h(
    "div",
    { class: "voice-form" },
    h("label", { class: "voice-field", for: "voice-provider" }, "Voice provider", provider),
    h("label", { class: "voice-field", for: "voice-id" }, "ElevenLabs voice id", voiceId),
    h("label", { class: "voice-field", for: "voice-key" }, "ElevenLabs API key", apiKey, keyHint),
    save,
    h(
      "p",
      { class: "voice-note" },
      "ElevenLabs replies are generated with your own API key — text you send is processed by their service. The built-in voice never leaves this computer.",
    ),
  );
}

function kv(k: string, v: string, mono = false): HTMLElement {
  return h(
    "div",
    { class: "kv" },
    h("span", { class: "k" }, k),
    h("span", { class: mono ? "v mono" : "v" }, v),
  );
}

function injectThemeStyle(): void {
  if (document.getElementById("settings-css") !== null) return;
  const style = document.createElement("style");
  style.id = "settings-css";
  style.textContent = `
    .theme-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .theme-swatch { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); color: var(--ink); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
    .theme-swatch:hover { background: var(--surface-strong); }
    .theme-swatch[aria-current="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .sw-chip { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border-strong); }
    .sw-dark { background: linear-gradient(135deg, #1a1a26, #0c0b12); }
    .sw-glass { background: linear-gradient(135deg, #eef2fe, #fdeef5); }
    .sw-hearth { background: linear-gradient(135deg, #3a2a20, #ffb454); }
    .voice-form { display: flex; flex-direction: column; gap: 14px; max-width: 460px; }
    .voice-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--ink-soft); }
    .voice-hint { margin: 0; font-size: 12.5px; font-weight: 400; color: var(--ink-faint); }
    .voice-note { margin: 0; font-size: 12.5px; color: var(--ink-faint); line-height: 1.5; }
    .voice-form .btn { align-self: flex-start; }
  `;
  document.head.append(style);
}
