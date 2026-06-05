import { describe, expect, test } from "bun:test";
import type { AppendEventInput } from "../storage/types.ts";
import { auditVoiceTurn, VOICE_EVENT_SOURCE, type VoiceAuditStore } from "./audit.ts";

function fakeStore(): { store: VoiceAuditStore; events: AppendEventInput[] } {
  const events: AppendEventInput[] = [];
  const store: VoiceAuditStore = {
    appendEvent(input) {
      events.push(input);
      return `evt-${events.length}`;
    },
  };
  return { store, events };
}

describe("auditVoiceTurn", () => {
  test("writes one voice-sourced row with the core payload", () => {
    const { store, events } = fakeStore();
    const id = auditVoiceTurn(store, {
      kind: "voice_conversed",
      provider: "local",
      brain: "cli",
      modality: "conversation",
      durationMs: 1234,
      sentenceCount: 3,
    });
    expect(id).toBe("evt-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      source: VOICE_EVENT_SOURCE,
      kind: "voice_conversed",
      payload: {
        provider: "local",
        brain: "cli",
        modality: "conversation",
        durationMs: 1234,
        sentenceCount: 3,
      },
    });
  });

  test("omits cloud-only fields on the local path", () => {
    const { store, events } = fakeStore();
    auditVoiceTurn(store, {
      kind: "voice_spoken",
      provider: "local",
      brain: "cli",
      modality: "speak",
      durationMs: 10,
    });
    const payload = events[0]?.payload ?? {};
    expect("costEstimate" in payload).toBe(false);
    expect("vaultKey" in payload).toBe(false);
  });

  test("records vault KEY name + cost on the cloud path (never a secret value)", () => {
    const { store, events } = fakeStore();
    auditVoiceTurn(store, {
      kind: "voice_conversed",
      provider: "elevenlabs",
      brain: "elevenlabs-cai",
      modality: "conversation",
      durationMs: 500,
      costEstimate: 0.012,
      vaultKey: "elevenlabs_api_key",
    });
    expect(events[0]?.payload.vaultKey).toBe("elevenlabs_api_key");
    expect(events[0]?.payload.costEstimate).toBe(0.012);
  });
});
