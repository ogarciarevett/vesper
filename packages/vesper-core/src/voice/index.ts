// @vesper/core voice — local-first conversational voice. The brain stays the
// user's CLI (Hard rule 12); STT/TTS are local I/O. The Rust/Tauri native shell
// (mic, Whisper, hotkey, injection) lands in a follow-up; this module is the
// host-side seam: provider, sentence chunker, turn orchestrator, and audit.
export {
  auditVoiceTurn,
  VOICE_EVENT_SOURCE,
  type VoiceAuditInput,
  type VoiceAuditStore,
} from "./audit.ts";
export { splitSentences, streamSentences } from "./chunker.ts";
export {
  runVoiceTurn,
  type VoiceTurnDeps,
  type VoiceTurnResult,
  type VoiceTurnSettings,
} from "./conversation.ts";
export {
  DEFAULT_ELEVENLABS_MODEL_ID,
  DEFAULT_ELEVENLABS_VOICE_ID,
  ELEVENLABS_ALLOWED_HOSTS,
  type ElevenLabsTtsOptions,
  elevenLabsTts,
} from "./elevenlabs.ts";
export { VoiceError, type VoiceErrorReason } from "./errors.ts";
export {
  createVoiceProvider,
  LocalVoiceProvider,
  type LocalVoiceProviderDeps,
  type VoiceProviderDeps,
} from "./provider.ts";
export {
  DEFAULT_VOICE_SETTINGS,
  type VoiceBackend,
  type VoiceBrain,
  type VoiceProvider,
  type VoiceRoute,
  type VoiceSettings,
} from "./types.ts";
