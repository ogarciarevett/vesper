import { VesperError } from "../errors.ts";

/** Discriminant reasons for {@link VoiceError}. */
export type VoiceErrorReason =
  /** A local capability needs the native (Tauri/Rust) shell, which is not wired in this context. */
  | "stt_unavailable"
  /** The selected TTS backend could not render/play speech (e.g. `say` missing off-macOS). */
  | "tts_unavailable"
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
