import { describe, expect, test } from "bun:test";
import { type AppendEventInput, VoiceError, type VoiceProvider } from "@vesper/core";
import { runAsk, runSay } from "./voice.ts";

function fakeProvider(over: Partial<VoiceProvider> = {}): VoiceProvider {
  return {
    id: "local",
    transcribe: () => Promise.reject(new Error("unused")),
    speak: () => Promise.resolve(),
    ...over,
  };
}

function fakeStore(): {
  store: { appendEvent(i: AppendEventInput): string };
  events: AppendEventInput[];
} {
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

/** A batch brain yielding `reply` as one chunk. */
function brain(reply: string) {
  return () =>
    (async function* () {
      yield reply;
    })();
}

describe("runSay", () => {
  test("speaks the text and reports success", async () => {
    const spoken: string[] = [];
    const out: string[] = [];
    const code = await runSay({
      provider: fakeProvider({
        speak: (t) => {
          spoken.push(t);
          return Promise.resolve();
        },
      }),
      text: "hello there",
      out: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(spoken).toEqual(["hello there"]);
  });

  test("refuses empty text without speaking", async () => {
    let called = false;
    const code = await runSay({
      provider: fakeProvider({
        speak: () => {
          called = true;
          return Promise.resolve();
        },
      }),
      text: "   ",
      out: () => {},
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
  });

  test("reports a friendly message and exit 1 when TTS is unavailable", async () => {
    const out: string[] = [];
    const code = await runSay({
      provider: fakeProvider({
        speak: () => Promise.reject(new VoiceError("tts_unavailable", "no `say` here")),
      }),
      text: "hi",
      out: (l) => out.push(l),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("unavailable");
  });
});

describe("runAsk", () => {
  test("prints the brain's reply and audits the turn", async () => {
    const out: string[] = [];
    const { store, events } = fakeStore();
    const code = await runAsk({
      transcript: "what is vesper",
      brain: brain("Vesper is a local-first agent runtime."),
      provider: fakeProvider(),
      store,
      settings: { brain: "cli", tts: "local", speakReplies: false },
      out: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["Vesper is a local-first agent runtime."]);
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("voice");
  });

  test("speaks the reply when speakReplies is true", async () => {
    const spoken: string[] = [];
    const { store } = fakeStore();
    await runAsk({
      transcript: "hi",
      brain: brain("One. Two."),
      provider: fakeProvider({
        speak: (t) => {
          spoken.push(t);
          return Promise.resolve();
        },
      }),
      store,
      settings: { brain: "cli", tts: "local", speakReplies: true },
      out: () => {},
    });
    expect(spoken).toEqual(["One.", "Two."]);
  });

  test("refuses empty input", async () => {
    const { store, events } = fakeStore();
    const code = await runAsk({
      transcript: "  ",
      brain: brain("unused"),
      provider: fakeProvider(),
      store,
      settings: { brain: "cli", tts: "local", speakReplies: false },
      out: () => {},
    });
    expect(code).toBe(1);
    expect(events).toHaveLength(0);
  });
});
