import { CommandNotFoundError, type ProcessRunner } from "../process/run.ts";
import { VoiceError } from "./errors.ts";
import type { VoiceBackend, VoiceProvider } from "./types.ts";

/** Construction options for {@link LocalVoiceProvider}. */
export interface LocalVoiceProviderDeps {
  /** Shell-out seam — injected so tests never spawn a real process. */
  readonly runner: ProcessRunner;
  /** TTS command. Default macOS `say`. */
  readonly ttsCommand?: string;
  /** Args placed BEFORE the text (e.g. `["-v", "Samantha"]` to pick a voice). */
  readonly ttsArgs?: readonly string[];
}

/** Default macOS text-to-speech binary. */
const DEFAULT_TTS_COMMAND = "say";

/**
 * The fully-local voice backend. TTS plays on-device through the system speech
 * binary (`say` on macOS); STT (Whisper) runs in the native (Tauri/Rust) shell,
 * so {@link LocalVoiceProvider.transcribe} rejects with `stt_unavailable` here
 * rather than reaching for the network. Makes ZERO network or vault calls.
 */
export class LocalVoiceProvider implements VoiceProvider {
  readonly id: VoiceBackend = "local";
  readonly #runner: ProcessRunner;
  readonly #command: string;
  readonly #args: readonly string[];

  constructor(deps: LocalVoiceProviderDeps) {
    this.#runner = deps.runner;
    this.#command = deps.ttsCommand ?? DEFAULT_TTS_COMMAND;
    this.#args = deps.ttsArgs ?? [];
  }

  transcribe(_audioRef: string): Promise<string> {
    return Promise.reject(
      new VoiceError(
        "stt_unavailable",
        "local speech-to-text runs in the native voice shell (Whisper) and is not wired in this context",
      ),
    );
  }

  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    try {
      const result = await this.#runner(this.#command, [...this.#args, trimmed]);
      if (result.exitCode !== 0) {
        throw new VoiceError(
          "tts_unavailable",
          `TTS command '${this.#command}' exited ${result.exitCode}`,
        );
      }
    } catch (cause) {
      if (cause instanceof VoiceError) throw cause;
      if (cause instanceof CommandNotFoundError) {
        throw new VoiceError("tts_unavailable", `local TTS command not found: ${this.#command}`, {
          cause,
        });
      }
      throw new VoiceError("tts_unavailable", "local TTS failed", { cause });
    }
  }
}

/** Dependencies for {@link createVoiceProvider} (currently just the local backend's). */
export type VoiceProviderDeps = LocalVoiceProviderDeps;

/**
 * Build the configured {@link VoiceProvider}. Only the local backend ships in this
 * slice; the opt-in ElevenLabs backend (fetch-only, vault-gated) is deferred to the
 * cloud-path follow-up and reports `unknown_provider` until then.
 */
export function createVoiceProvider(backend: VoiceBackend, deps: VoiceProviderDeps): VoiceProvider {
  if (backend === "local") return new LocalVoiceProvider(deps);
  throw new VoiceError(
    "unknown_provider",
    `the '${backend}' voice backend is opt-in and not enabled in this build (local-only)`,
  );
}
