/// <reference lib="dom" />

/**
 * Speech helpers for the chat composer — dependency-free, no module-load side
 * effects (safe to import under bun:test for the pure {@link stripForSpeech}).
 *
 * Speaking a reply tries the daemon's TTS route first (`POST /api/voice/tts` —
 * ElevenLabs when the user configured a key in Settings) and falls back to the
 * browser's local `speechSynthesis` otherwise. A module-level current-audio ref
 * guarantees replies never overlap: every new utterance stops the previous one.
 */

// --- Minimal Web Speech API typings (not in the standard DOM lib; avoid `any`). ----------
export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}
export interface SpeechRecognitionResultLike {
  readonly 0: SpeechRecognitionAlternativeLike;
  readonly isFinal: boolean;
}
export interface SpeechRecognitionEventLike {
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
  readonly resultIndex: number;
}
export interface SpeechRecognitionLike {
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
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Resolve the browser's SpeechRecognition constructor (std or webkit-prefixed), or null. */
export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Strip markdown artifacts so TTS reads naturally: fenced code blocks are
 * dropped entirely (code read aloud is noise), inline backticks / emphasis
 * marks / heading hashes are removed keeping their text, and links keep only
 * their label. Pure — exported for tests.
 */
export function stripForSpeech(text: string): string {
  return (
    text
      // Fenced code blocks (with or without a language tag) are dropped whole.
      .replace(/```[\s\S]*?```/g, "")
      // A dangling unterminated fence line.
      .replace(/^```.*$/gm, "")
      // Inline code keeps its content.
      .replace(/`([^`]*)`/g, "$1")
      // Images and links keep their label, never the URL.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Heading hashes and blockquote markers at line start.
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      // Emphasis / bold / list-star markers.
      .replace(/\*+/g, "")
      .replace(/^[-_]{3,}\s*$/gm, "")
      // Collapse the whitespace the removals leave behind.
      .replace(/^[ \t]+$/gm, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** The currently playing reply (server audio), so a new one always stops it first. */
let currentAudio: HTMLAudioElement | null = null;

/** Stop any in-flight spoken reply — both server audio and local synthesis. */
export function stopSpeaking(): void {
  if (currentAudio !== null) {
    const audio = currentAudio;
    currentAudio = null;
    audio.pause();
    audio.removeAttribute("src");
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/**
 * Speak `text` aloud. Tries `POST /api/voice/tts` (same-origin): a 200 with an
 * `audio/*` body plays the returned clip; anything else (ElevenLabs not
 * configured, a network error) falls back to the browser's `speechSynthesis`.
 */
export async function speakText(text: string): Promise<void> {
  stopSpeaking();
  const cleaned = text.trim();
  if (cleaned.length === 0) return;
  try {
    const res = await fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: cleaned }),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && contentType.startsWith("audio/")) {
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      currentAudio = audio;
      const release = (): void => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
      };
      audio.addEventListener("ended", release);
      audio.addEventListener("error", release);
      try {
        await audio.play();
        return;
      } catch {
        release(); // autoplay blocked — fall back to local synthesis below.
      }
    }
  } catch {
    // Network error — the local voice below still answers.
  }
  speakLocally(cleaned);
}

/** Local fallback: the browser's `speechSynthesis` (the computer's own voice). */
function speakLocally(text: string): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
