import { auditVoiceTurn, type VoiceAuditStore } from "./audit.ts";
import { streamSentences } from "./chunker.ts";
import type { VoiceBackend, VoiceBrain, VoiceProvider } from "./types.ts";

/** The slice of {@link import("./types.ts").VoiceSettings} a turn needs. */
export interface VoiceTurnSettings {
  readonly brain: VoiceBrain;
  readonly tts: VoiceBackend;
  /** Speak the reply aloud (Mode A); when false the turn is text-only. */
  readonly speakReplies: boolean;
}

/** Inputs for one Mode-A conversation turn. */
export interface VoiceTurnDeps {
  /** The user's transcribed utterance — becomes the brain prompt. */
  readonly transcript: string;
  /**
   * The reasoner. Yields the reply as a stream of text chunks; a batch CLI
   * completion is simply one chunk. The host adapts `ctx.complete` into this.
   */
  readonly brain: (prompt: string) => AsyncIterable<string>;
  /** Voice I/O backend whose `speak` plays each sentence. */
  readonly provider: VoiceProvider;
  /** Where the single audit row is written. */
  readonly store: VoiceAuditStore;
  readonly settings: VoiceTurnSettings;
  /** Barge-in: when aborted, no further sentence is spoken. */
  readonly signal?: AbortSignal;
  /** Injectable clock for `durationMs` (default {@link Date.now}). */
  readonly now?: () => number;
}

/** The outcome of a conversation turn. */
export interface VoiceTurnResult {
  /** The full reply text from the brain (verbatim, trimmed). */
  readonly reply: string;
  /** The reply split into spoken-order sentences. */
  readonly sentences: readonly string[];
  /** How many sentences were actually spoken (< sentences.length if barged-in). */
  readonly spokenCount: number;
  /** Wall-clock duration of the turn. */
  readonly durationMs: number;
  /** Id of the audit row written for the turn. */
  readonly eventId: string;
}

/**
 * Run one Mode-A voice turn: the transcript goes to the brain (the user's CLI by
 * default — Hard rule 12), the streamed reply is chunked into sentences, and each
 * sentence is spoken as soon as it is ready (so the first words play without
 * waiting for the whole reply). Barge-in stops further speech. Exactly one audit
 * row is written. Makes no network or vault call on the local path.
 */
export async function runVoiceTurn(deps: VoiceTurnDeps): Promise<VoiceTurnResult> {
  const { transcript, brain, provider, store, settings, signal } = deps;
  const clock = deps.now ?? Date.now;
  const start = clock();

  let raw = "";
  const reChunked = (async function* () {
    for await (const chunk of brain(transcript)) {
      raw += chunk;
      yield chunk;
    }
  })();

  const sentences: string[] = [];
  let spokenCount = 0;
  for await (const sentence of streamSentences(reChunked)) {
    sentences.push(sentence);
    if (settings.speakReplies && signal?.aborted !== true) {
      await provider.speak(sentence);
      spokenCount += 1;
    }
  }

  const durationMs = clock() - start;
  const eventId = auditVoiceTurn(store, {
    kind: "voice_conversed",
    provider: settings.tts,
    brain: settings.brain,
    modality: "conversation",
    durationMs,
    sentenceCount: sentences.length,
  });

  return { reply: raw.trim(), sentences, spokenCount, durationMs, eventId };
}
