/// <reference lib="dom" />
import { ICONS } from "../shell/icons.ts";
import {
  h,
  injectStyle,
  type SectionContext,
  type SectionModule,
  sectionHeader,
} from "../shell/section.ts";

/**
 * Voice — "Talk to Vesper" in the focused window (the voice spec's Mode A).
 *
 * Pure client-side voice I/O wrapped around the EXISTING chatbot: speech-to-text via the
 * browser's `SpeechRecognition` (feature-detected), the brain is `POST /api/chat` (the
 * router -> the user's CLI, Hard rule 12 intact — Vesper adds no LLM SDK and no cloud voice
 * provider), and replies are spoken with the browser's local `speechSynthesis`. Needs NO
 * native shell: the deferred Tauri/Whisper work is only for SYSTEM-WIDE dictation (Mode B);
 * an in-window conversation runs here today.
 *
 * Local-first note: `speechSynthesis` uses your OS voices (fully local). Browser speech
 * RECOGNITION may route audio through an online service depending on the browser — so mic
 * input is an opt-in, feature-detected enhancement, and typing always works as the fallback.
 */

// --- Minimal Web Speech API typings (not in the standard DOM lib; avoid `any`). ----------
interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly 0: SpeechRecognitionAlternativeLike;
  readonly isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
  readonly resultIndex: number;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Resolve the browser's SpeechRecognition constructor (std or webkit-prefixed), or null. */
function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const STYLE_ID = "sec-voice-style";
const STYLE = `
.vc-wrap { display: flex; flex-direction: column; gap: 16px; max-width: 720px; }
.vc-stage { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 22px;
  border: 1px solid var(--border); border-radius: 16px; background: var(--surface-2); }
.vc-mic { width: 92px; height: 92px; border-radius: 999px; border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--accent); display: grid; place-items: center; cursor: pointer;
  transition: transform .12s ease, box-shadow .2s ease, background .2s ease; }
.vc-mic svg { width: 38px; height: 38px; }
.vc-mic:hover { transform: translateY(-1px); }
.vc-mic:disabled { opacity: .5; cursor: not-allowed; }
.vc-mic.listening { background: var(--accent); color: #fff; box-shadow: 0 0 0 6px var(--accent-soft); }
.vc-status { font-size: 14px; font-weight: 600; color: var(--ink-soft); min-height: 20px; }
.vc-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-soft); }
.vc-thread { display: flex; flex-direction: column; gap: 10px; }
.vc-bubble { max-width: 85%; padding: 11px 14px; border-radius: 15px; font-size: 14.5px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; }
.vc-bubble.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 5px; }
.vc-bubble.assistant { align-self: flex-start; background: var(--surface-2); color: var(--ink);
  border: 1px solid var(--border); border-bottom-left-radius: 5px; }
.vc-fallback { display: flex; gap: 8px; }
.vc-fallback .field { flex: 1; }
.vc-note { font-size: 12.5px; color: var(--ink-faint); line-height: 1.5; }
`;

export const voiceSection: SectionModule = {
  id: "voice",
  title: "Voice",
  group: "computer",
  glyph: ICONS.voice,
  mount(host: HTMLElement, ctx: SectionContext) {
    injectStyle(STYLE_ID, STYLE);
    host.append(
      sectionHeader(
        "Talk to Vesper",
        "Speak to Vesper and hear it answer — right here in the window.",
      ),
    );

    const ctor = speechRecognitionCtor();
    const tts = "speechSynthesis" in window ? window.speechSynthesis : null;

    let sessionId: string | null = null;
    let listening = false;
    let busy = false;
    let speakReplies = true;
    let recognition: SpeechRecognitionLike | null = null;

    const status = h(
      "div",
      { class: "vc-status" },
      ctor === null ? "Type below to talk to Vesper" : "Tap the mic and talk",
    );
    const mic = h("button", {
      class: "vc-mic",
      type: "button",
      "aria-label": "Talk to Vesper",
      html: ICONS.voice,
    });
    const speakChk = h("input", { type: "checkbox", id: "vc-speak" });
    speakChk.checked = true;
    const toggle = h(
      "label",
      { class: "vc-toggle", for: "vc-speak" },
      speakChk,
      tts === null ? "Spoken replies unavailable in this browser" : "Speak replies aloud",
    );
    const stage = h("div", { class: "vc-stage" }, mic, status, toggle);
    const thread = h("div", { class: "vc-thread" });

    const input = h("input", {
      class: "field",
      type: "text",
      placeholder: "…or type your message",
      "aria-label": "Message to Vesper",
    });
    const sendBtn = h("button", { class: "btn primary", type: "button" }, "Send");
    const fallback = h("div", { class: "vc-fallback" }, input, sendBtn);

    const note = h(
      "p",
      { class: "vc-note" },
      tts !== null ? "Replies are spoken with your computer's built-in voice (stays local). " : "",
      ctor !== null
        ? "Voice input uses your browser's speech recognition, which may send audio to an online service depending on the browser."
        : "This browser has no speech recognition — type your message and Vesper will reply (and speak, where supported).",
    );

    host.append(h("div", { class: "vc-wrap" }, stage, thread, fallback, note));

    const setStatus = (text: string): void => {
      status.textContent = text;
    };

    const bubble = (role: "user" | "assistant", text: string): void => {
      thread.append(h("div", { class: `vc-bubble ${role}` }, text));
      thread.scrollIntoView({ block: "end" });
    };

    const speak = (text: string): void => {
      if (tts === null || !speakReplies || text.length === 0) return;
      tts.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.onstart = () => setStatus("Speaking…");
      utter.onend = () =>
        setStatus(ctor === null ? "Type below to talk to Vesper" : "Tap the mic and talk");
      tts.speak(utter);
    };

    /** One conversational turn: text -> chatbot (CLI brain) -> bubble + spoken reply. */
    const sendTurn = async (text: string): Promise<void> => {
      const message = text.trim();
      if (message.length === 0 || busy) return;
      busy = true;
      bubble("user", message);
      setStatus("Thinking…");
      try {
        const body = await ctx.api.postJson<{ sessionId?: string; reply?: string }>(
          "/api/chat",
          sessionId === null ? { message } : { sessionId, message },
        );
        if (typeof body.sessionId === "string") sessionId = body.sessionId;
        const reply =
          typeof body.reply === "string" && body.reply.length > 0 ? body.reply : "(no response)";
        bubble("assistant", reply);
        speak(reply);
        if (tts === null || !speakReplies) setStatus("Tap the mic and talk");
      } catch (err) {
        setStatus("");
        ctx.toast(err instanceof Error ? err.message : "Could not reach Vesper");
      } finally {
        busy = false;
      }
    };

    const stopListening = (): void => {
      listening = false;
      mic.classList.remove("listening");
      recognition?.stop();
    };

    const startListening = (): void => {
      if (ctor === null || busy) return;
      tts?.cancel(); // barge-in: stop speaking when the user starts talking
      const rec = new ctor();
      recognition = rec;
      rec.lang = navigator.language || "en-US";
      rec.continuous = false;
      rec.interimResults = false;
      rec.onresult = (e) => {
        const last = e.results[e.results.length - 1];
        const transcript = last?.[0]?.transcript ?? "";
        if (transcript.trim().length > 0) void sendTurn(transcript);
      };
      rec.onerror = (e) => {
        ctx.toast(`Voice input error: ${e.error ?? "unknown"}`);
        stopListening();
      };
      rec.onend = () => {
        listening = false;
        mic.classList.remove("listening");
      };
      listening = true;
      mic.classList.add("listening");
      setStatus("Listening…");
      rec.start();
    };

    mic.addEventListener("click", () => {
      if (ctor === null) {
        input.focus();
        return;
      }
      if (listening) stopListening();
      else startListening();
    });
    speakChk.addEventListener("change", () => {
      speakReplies = speakChk.checked;
      if (!speakReplies) tts?.cancel();
    });
    const submitTyped = (): void => {
      const text = input.value;
      input.value = "";
      void sendTurn(text);
    };
    sendBtn.addEventListener("click", submitTyped);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitTyped();
    });

    if (ctor === null) mic.disabled = true;

    ctx.onCleanup(() => {
      recognition?.abort();
      tts?.cancel();
    });
  },
};
