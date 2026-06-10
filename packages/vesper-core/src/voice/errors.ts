import { VesperError } from "../errors.ts";

/** Discriminant reasons for {@link VoiceError}. */
export type VoiceErrorReason =
  /** A local capability needs the native (Tauri/Rust) shell, which is not wired in this context. */
  | "stt_unavailable"
  /** The selected TTS backend could not render/play speech (e.g. `say` missing off-macOS). */
  | "tts_unavailable"
  /** A cloud TTS request failed with a non-OK, non-auth HTTP response. */
  | "tts_failed"
  /** The cloud TTS provider rejected the supplied credentials (HTTP 401/403). */
  | "not_authorized"
  /** TTS was asked to speak empty/whitespace text — refused before any network work. */
  | "empty_text"
  /** The opt-in cloud path tried to reach a host outside its allowlist. */
  | "network_denied"
  /** The configured provider id is not recognised. */
  | "unknown_provider";

/**
 * Raised by the voice subsystem, discriminated by {@link VoiceError.reason}.
 * Carries `code = "voice"` (inherited from {@link VesperError}) so cross-subsystem
 * catch blocks can branch on `reason` rather than string-matching messages.
 */
export class VoiceError extends VesperError {
  readonly reason: VoiceErrorReason;

  constructor(reason: VoiceErrorReason, message: string, options?: ErrorOptions) {
    super("voice", message, options);
    this.reason = reason;
  }
}
