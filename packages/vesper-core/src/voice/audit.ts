import type { AppendEventInput } from "../storage/types.ts";
import type { VoiceBackend, VoiceBrain } from "./types.ts";

/** The `events.source` value every voice audit row carries. */
export const VOICE_EVENT_SOURCE = "voice";

/** A minimal store seam — just the append the audit needs (keeps callers easy to fake). */
export interface VoiceAuditStore {
  appendEvent(input: AppendEventInput): string;
}

/** What a finished voice turn records. Deliberately carries NO transcript or key value. */
export interface VoiceAuditInput {
  readonly kind: "voice_conversed" | "voice_transcribed" | "voice_spoken";
  /** STT/TTS backend that served the turn. */
  readonly provider: VoiceBackend;
  /** Reasoner that answered (CLI by default). */
  readonly brain: VoiceBrain;
  readonly modality: "conversation" | "dictation" | "speak";
  readonly durationMs: number;
  /** Sentences spoken/produced, when relevant. */
  readonly sentenceCount?: number;
  /** Cloud path only: estimated spend in USD. */
  readonly costEstimate?: number;
  /** Cloud path only: the NAME of the vault key used — NEVER its value. */
  readonly vaultKey?: string;
}

/**
 * Record exactly one audit row for a completed voice turn. The payload captures
 * provider + brain + modality + duration (+ cost and vault KEY name on the cloud
 * path) and never the raw transcript, reply text, or any secret value — the input
 * type has no field for those, so a leak is impossible by construction.
 */
export function auditVoiceTurn(store: VoiceAuditStore, input: VoiceAuditInput): string {
  const payload: Record<string, unknown> = {
    provider: input.provider,
    brain: input.brain,
    modality: input.modality,
    durationMs: input.durationMs,
  };
  if (input.sentenceCount !== undefined) payload.sentenceCount = input.sentenceCount;
  if (input.costEstimate !== undefined) payload.costEstimate = input.costEstimate;
  if (input.vaultKey !== undefined) payload.vaultKey = input.vaultKey;
  return store.appendEvent({ source: VOICE_EVENT_SOURCE, kind: input.kind, payload });
}
