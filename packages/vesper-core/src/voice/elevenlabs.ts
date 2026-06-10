/**
 * Opt-in cloud TTS — the ElevenLabs half of specs/voice-conversation.md. The
 * BRAIN stays the user's CLI (Hard rule 12 untouched): this module only turns
 * text Vesper already produced into speech, using the user's OWN ElevenLabs
 * API key. All egress goes through {@link allowlistedFetch} pinned to exactly
 * `api.elevenlabs.io` — no SDK, no other host, ever.
 */

import type { Capability } from "../capabilities/index.ts";
import { allowlistedFetch, type FetchFn } from "../connections/fetch.ts";
import { VoiceError } from "./errors.ts";

export const ELEVENLABS_ALLOWED_HOSTS: readonly string[] = ["api.elevenlabs.io"];

/** Rachel — ElevenLabs' standard default voice. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** Low-latency conversational model. */
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";

/** Options for {@link elevenLabsTts}. */
export interface ElevenLabsTtsOptions {
  /** The user's own ElevenLabs API key. NEVER echoed into errors or logs. */
  readonly apiKey: string;
  /** Voice to synthesize with; defaults to {@link DEFAULT_ELEVENLABS_VOICE_ID}. */
  readonly voiceId?: string;
  /** Model to synthesize with; defaults to {@link DEFAULT_ELEVENLABS_MODEL_ID}. */
  readonly modelId?: string;
  /** Capabilities the caller was granted; MUST include `NETWORK_FETCH`. */
  readonly granted: readonly Capability[];
  /** Injected for tests; production omits it for the real fetch. */
  readonly fetchFn?: FetchFn;
}

/**
 * Synthesize `text` to MP3 bytes via the ElevenLabs text-to-speech endpoint.
 *
 * Refuses empty/whitespace text ({@link VoiceError}("empty_text")) and a
 * missing `NETWORK_FETCH` grant BEFORE any network work. HTTP 401/403 raise
 * `VoiceError("not_authorized")`; any other non-OK status raises
 * `VoiceError("tts_failed")` carrying the status. Error messages never
 * include the API key.
 */
export async function elevenLabsTts(
  text: string,
  options: ElevenLabsTtsOptions,
): Promise<{ audio: Uint8Array; mime: "audio/mpeg" }> {
  if (text.trim() === "") {
    throw new VoiceError("empty_text", "TTS refused: text is empty");
  }

  const voiceId = options.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = options.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;

  const response = await allowlistedFetch({
    url,
    allowedHosts: ELEVENLABS_ALLOWED_HOSTS,
    granted: options.granted,
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    init: {
      method: "POST",
      headers: { "xi-api-key": options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: modelId }),
    },
  });

  if (response.status === 401 || response.status === 403) {
    // Distinguish bad credentials; the message names the status, never the key.
    throw new VoiceError(
      "not_authorized",
      `ElevenLabs rejected the API key (HTTP ${response.status})`,
    );
  }
  if (!response.ok) {
    throw new VoiceError("tts_failed", `ElevenLabs TTS failed (HTTP ${response.status})`);
  }

  return { audio: new Uint8Array(await response.arrayBuffer()), mime: "audio/mpeg" };
}
