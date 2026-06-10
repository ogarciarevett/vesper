/**
 * Which reasoner answers a voice turn. `"cli"` (default) keeps the brain on the
 * user's already-authenticated CLI (Hard rule 12 intact); `"elevenlabs-cai"` is
 * the opt-up premium speech-native brain (owned by the deferred cloud path).
 */
export type VoiceBrain = "cli" | "elevenlabs-cai";

/** Which backend renders speech-to-text / text-to-speech. */
export type VoiceBackend = "local" | "elevenlabs";

/** How a captured utterance is routed (focus-aware by default — resolved in the shell). */
export type VoiceRoute = "auto" | "vesper" | "dictate";

/**
 * The resolved, validated voice settings the host hands to the core voice module.
 * Mirrors the `voice` block of `~/.vesper/config.json` but is defined in
 * `vesper-core` so the module stays decoupled from the CLI's config loader
 * (same pattern as {@link import("../scheduler/types.ts").NotifyIntent}).
 */
export interface VoiceSettings {
  readonly route: VoiceRoute;
  readonly brain: VoiceBrain;
  readonly stt: VoiceBackend;
  readonly tts: VoiceBackend;
  readonly hotkey: string;
  readonly model: string;
  readonly bargeIn: boolean;
  readonly speakReplies: boolean;
  /** ElevenLabs voice id (tts "elevenlabs" only); module default when unset. */
  readonly elevenLabsVoiceId?: string;
  /** ElevenLabs model id (tts "elevenlabs" only); module default when unset. */
  readonly elevenLabsModelId?: string;
}

/** The fully-local, offline, free, private default — brain on the CLI, I/O on-device. */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  route: "auto",
  brain: "cli",
  stt: "local",
  tts: "local",
  hotkey: "Alt+Z",
  model: "whisper-small",
  bargeIn: true,
  speakReplies: true,
};

/**
 * A voice I/O backend: speech-to-text and text-to-speech. The local provider
 * proxies to on-device tools (Whisper in the shell; macOS `say` for TTS); the
 * opt-in ElevenLabs provider (deferred) is a fetch-only client gated by
 * `NETWORK_FETCH` + `READ_VAULT`. Selected by config — never both at once.
 */
export interface VoiceProvider {
  /** Machine-readable backend id (e.g. `"local"`, `"elevenlabs"`). */
  readonly id: VoiceBackend;

  /**
   * Transcribe a captured utterance to text. The local provider needs the native
   * shell (Whisper); when that bridge is absent it rejects with
   * `VoiceError("stt_unavailable")` rather than touching the network.
   */
  transcribe(audioRef: string): Promise<string>;

  /**
   * Render and play `text` as speech. The local provider plays on-device (macOS
   * `say`) and resolves when playback is enqueued; it MUST be interruptible by the
   * shell's barge-in. Rejects with `VoiceError("tts_unavailable")` when no local
   * TTS backend exists (e.g. off macOS).
   */
  speak(text: string): Promise<void>;
}
