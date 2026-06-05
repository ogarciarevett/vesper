import { describe, expect, test } from "bun:test";
import type { AppendEventInput } from "../storage/types.ts";
import type { VoiceAuditStore } from "./audit.ts";
import { runVoiceTurn } from "./conversation.ts";
import type { VoiceProvider } from "./types.ts";

/** A provider that logs spoken text; transcribe is unused in Mode A. */
function recordingProvider(log: string[]): VoiceProvider {
  return {
    id: "local",
    transcribe: () => Promise.reject(new Error("unused")),
    speak: (text) => {
      log.push(`speak:${text}`);
      return Promise.resolve();
    },
  };
}

function fakeStore(): { store: VoiceAuditStore; events: AppendEventInput[] } {
  const events: AppendEventInput[] = [];
  return {
    store: {
      appendEvent(input) {
        events.push(input);
        return `evt-${events.length}`;
      },
    },
    events,
  };
}

/** A batch brain: yields the whole reply as a single chunk (today's CompleteFn shape). */
function batchBrain(reply: string): (prompt: string) => AsyncIterable<string> {
  return () =>
    (async function* () {
      yield reply;
    })();
}

describe("runVoiceTurn", () => {
  test("the reply comes from the brain and every sentence is spoken in order", async () => {
    const log: string[] = [];
    const { store, events } = fakeStore();
    const result = await runVoiceTurn({
      transcript: "how are you",
      brain: batchBrain("I am well. Thanks for asking!"),
      provider: recordingProvider(log),
      store,
      settings: { brain: "cli", tts: "local", speakReplies: true },
    });
    expect(result.reply).toBe("I am well. Thanks for asking!");
    expect(result.sentences).toEqual(["I am well.", "Thanks for asking!"]);
    expect(result.spokenCount).toBe(2);
    expect(log).toEqual(["speak:I am well.", "speak:Thanks for asking!"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      provider: "local",
      brain: "cli",
      modality: "conversation",
      sentenceCount: 2,
    });
  });

  test("speaks the first sentence before pulling the rest of the stream (no full-reply wait)", async () => {
    const log: string[] = [];
    const { store } = fakeStore();
    const brain = (): AsyncIterable<string> =>
      (async function* () {
        log.push("yield:1");
        yield "First sentence. ";
        log.push("yield:2");
        yield "Second sentence.";
      })();
    await runVoiceTurn({
      transcript: "hi",
      brain,
      provider: recordingProvider(log),
      store,
      settings: { brain: "cli", tts: "local", speakReplies: true },
    });
    // The first sentence is spoken BEFORE the second chunk is requested.
    expect(log).toEqual(["yield:1", "speak:First sentence.", "yield:2", "speak:Second sentence."]);
  });

  test("does not speak when speakReplies is false, but still returns the reply", async () => {
    const log: string[] = [];
    const { store, events } = fakeStore();
    const result = await runVoiceTurn({
      transcript: "hi",
      brain: batchBrain("Hello. World."),
      provider: recordingProvider(log),
      store,
      settings: { brain: "cli", tts: "local", speakReplies: false },
    });
    expect(log).toEqual([]);
    expect(result.spokenCount).toBe(0);
    expect(result.sentences).toHaveLength(2);
    expect(events[0]?.payload.sentenceCount).toBe(2);
  });

  test("barge-in: an aborted signal halts further speech mid-reply", async () => {
    const log: string[] = [];
    const { store } = fakeStore();
    const controller = new AbortController();
    const provider: VoiceProvider = {
      id: "local",
      transcribe: () => Promise.reject(new Error("unused")),
      speak: (text) => {
        log.push(`speak:${text}`);
        controller.abort(); // user starts talking after the first sentence
        return Promise.resolve();
      },
    };
    const result = await runVoiceTurn({
      transcript: "hi",
      brain: batchBrain("One. Two. Three."),
      provider,
      store,
      settings: { brain: "cli", tts: "local", speakReplies: true },
      signal: controller.signal,
    });
    expect(log).toEqual(["speak:One."]);
    expect(result.spokenCount).toBe(1);
  });

  test("computes durationMs from the injected clock", async () => {
    const { store, events } = fakeStore();
    const times = [1000, 1075];
    const result = await runVoiceTurn({
      transcript: "hi",
      brain: batchBrain("Done."),
      provider: recordingProvider([]),
      store,
      settings: { brain: "cli", tts: "local", speakReplies: true },
      now: () => times.shift() ?? 0,
    });
    expect(result.durationMs).toBe(75);
    expect(events[0]?.payload.durationMs).toBe(75);
  });

  test("the local conversation path makes ZERO network calls", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error("network forbidden on the local path"));
    }) as typeof fetch;
    try {
      const { store } = fakeStore();
      await runVoiceTurn({
        transcript: "hi",
        brain: batchBrain("No network here."),
        provider: recordingProvider([]),
        store,
        settings: { brain: "cli", tts: "local", speakReplies: true },
      });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
