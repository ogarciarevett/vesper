import type { AgentMessageType } from "@repo/types";

/** Default voice IDs from ElevenLabs — each agent gets a distinct voice */
export const DEFAULT_VOICE_IDS: Record<string, string> = {
  "voice-alpha": "21m00Tcm4TlvDq8ikWAM",   // Rachel
  "voice-beta": "EXAVITQu4vr4xnSDxMaL",    // Bella
  "voice-gamma": "ErXwobaYiN019PkySvjV",    // Antoni
  "voice-delta": "VR6AewLTigWG4xSOukaG",    // Arnold
  "voice-epsilon": "pNInz6obpgDQGcFmaJgB",  // Adam
  "voice-zeta": "yoZ06aMxZJJ28mfd3POQ",     // Sam
};

/** Message types that warrant voice synthesis (cost control) */
const VOICE_WORTHY_TYPES: Set<AgentMessageType> = new Set([
  "PROPOSAL",
  "REVIEW",
  "AGREEMENT",
  "DISAGREEMENT",
  "ANALYSIS",
]);

export interface VoiceConfig {
  apiKey: string;
  enabled: boolean;
}

export interface VoiceSynthResult {
  audioUrl: string;
  durationMs: number;
  charCount: number;
}

/**
 * ElevenLabs voice synthesis service.
 * Converts agent messages to speech and stores audio in R2.
 */
export class VoiceService {
  private readonly apiKey: string;
  private readonly enabled: boolean;

  constructor(config: VoiceConfig) {
    this.apiKey = config.apiKey;
    this.enabled = config.enabled && config.apiKey.length > 0;
  }

  /** Check if a message type should be voiced */
  shouldSynthesize(messageType: AgentMessageType): boolean {
    if (!this.enabled) return false;
    return VOICE_WORTHY_TYPES.has(messageType);
  }

  /** Get a voice ID for an agent, cycling through defaults */
  getVoiceId(agentId: string, customVoiceId?: string): string {
    if (customVoiceId) return customVoiceId;

    // Deterministic assignment based on agent ID hash
    const voiceKeys = Object.keys(DEFAULT_VOICE_IDS);
    let hash = 0;
    for (let i = 0; i < agentId.length; i++) {
      hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
    }
    const index = Math.abs(hash) % voiceKeys.length;
    return DEFAULT_VOICE_IDS[voiceKeys[index]!]!;
  }

  /**
   * Synthesize text to speech via ElevenLabs API.
   * Returns raw audio buffer (mp3).
   */
  async synthesize(
    text: string,
    voiceId: string,
  ): Promise<ArrayBuffer | null> {
    if (!this.enabled) return null;

    // Truncate to 500 chars for cost control
    const truncated = text.length > 500 ? `${text.slice(0, 497)}...` : text;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: truncated,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      },
    );

    if (!response.ok) {
      console.error(
        `ElevenLabs TTS failed: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    return response.arrayBuffer();
  }

  /**
   * Synthesize and store audio in R2 bucket.
   * Returns the public URL for the stored audio.
   */
  async synthesizeAndStore(
    text: string,
    voiceId: string,
    messageId: string,
    r2Bucket: R2Bucket,
  ): Promise<VoiceSynthResult | null> {
    const audio = await this.synthesize(text, voiceId);
    if (!audio) return null;

    const key = `voice/${messageId}.mp3`;
    await r2Bucket.put(key, audio, {
      httpMetadata: {
        contentType: "audio/mpeg",
      },
    });

    return {
      audioUrl: `/api/voice/${messageId}.mp3`,
      durationMs: Math.ceil((text.length / 15) * 1000), // rough estimate
      charCount: text.length,
    };
  }
}
