import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ELEVENLABS_MODEL_ID,
  DEFAULT_ELEVENLABS_VOICE_ID,
  ELEVENLABS_ALLOWED_HOSTS,
  elevenLabsTts,
} from "./elevenlabs.ts";
import { VoiceError } from "./errors.ts";

/** Never a real key — present so leak assertions have a needle to search for. */
const API_KEY = "xi-test-key-must-never-leak";

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

describe("elevenLabsTts", () => {
  test("POSTs the allowlisted TTS endpoint and returns the audio bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const calls: CapturedCall[] = [];
    const result = await elevenLabsTts("Hello there.", {
      apiKey: API_KEY,
      voiceId: "voice-123",
      modelId: "eleven_custom_v9",
      granted: ["NETWORK_FETCH"],
      fetchFn: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(bytes, { status: 200 }));
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice-123?output_format=mp3_44100_128",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe(API_KEY);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      text: "Hello there.",
      model_id: "eleven_custom_v9",
    });
    expect(result.mime).toBe("audio/mpeg");
    expect(result.audio).toEqual(bytes);
  });

  test("omitting voiceId/modelId uses the exported defaults", async () => {
    const calls: CapturedCall[] = [];
    await elevenLabsTts("Defaults please.", {
      apiKey: API_KEY,
      granted: ["NETWORK_FETCH"],
      fetchFn: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(new Uint8Array([0]), { status: 200 }));
      },
    });

    expect(calls[0]?.url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      text: "Defaults please.",
      model_id: DEFAULT_ELEVENLABS_MODEL_ID,
    });
  });

  test("empty/whitespace text is refused before any network work", async () => {
    let called = false;
    const error = await elevenLabsTts("   \n\t", {
      apiKey: API_KEY,
      granted: ["NETWORK_FETCH"],
      fetchFn: () => {
        called = true;
        return Promise.resolve(new Response(new Uint8Array([0])));
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoiceError);
    expect((error as VoiceError).reason).toBe("empty_text");
    expect(called).toBe(false);
  });

  test("refuses without NETWORK_FETCH before any network work", async () => {
    let called = false;
    await expect(
      elevenLabsTts("Hello.", {
        apiKey: API_KEY,
        granted: [],
        fetchFn: () => {
          called = true;
          return Promise.resolve(new Response(new Uint8Array([0])));
        },
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("401 reports bad credentials and never leaks the api key", async () => {
    const error = await elevenLabsTts("Hello.", {
      apiKey: API_KEY,
      granted: ["NETWORK_FETCH"],
      fetchFn: () => Promise.resolve(new Response("unauthorized", { status: 401 })),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoiceError);
    expect((error as VoiceError).reason).toBe("not_authorized");
    expect((error as VoiceError).message).not.toContain(API_KEY);
  });

  test("other non-OK statuses raise tts_failed naming the status, key never leaked", async () => {
    const error = await elevenLabsTts("Hello.", {
      apiKey: API_KEY,
      granted: ["NETWORK_FETCH"],
      fetchFn: () => Promise.resolve(new Response("boom", { status: 500 })),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoiceError);
    expect((error as VoiceError).reason).toBe("tts_failed");
    expect((error as VoiceError).message).toContain("500");
    expect((error as VoiceError).message).not.toContain(API_KEY);
  });

  test("the allowlist is pinned to exactly api.elevenlabs.io", () => {
    expect(ELEVENLABS_ALLOWED_HOSTS).toEqual(["api.elevenlabs.io"]);
  });
});
