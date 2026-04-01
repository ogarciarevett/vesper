import { afterEach, describe, expect, test } from "bun:test";
import { VoiceService, DEFAULT_VOICE_IDS } from "../src/voice/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("VoiceService", () => {
  test("shouldSynthesize returns false when disabled", () => {
    const service = new VoiceService({ apiKey: "", enabled: false });
    expect(service.shouldSynthesize("PROPOSAL")).toBe(false);
    expect(service.shouldSynthesize("ANALYSIS")).toBe(false);
  });

  test("shouldSynthesize returns false for non-voice-worthy types", () => {
    const service = new VoiceService({ apiKey: "test-key", enabled: true });
    expect(service.shouldSynthesize("THOUGHT")).toBe(false);
    expect(service.shouldSynthesize("STATUS_UPDATE")).toBe(false);
  });

  test("shouldSynthesize returns true for voice-worthy types", () => {
    const service = new VoiceService({ apiKey: "test-key", enabled: true });
    expect(service.shouldSynthesize("PROPOSAL")).toBe(true);
    expect(service.shouldSynthesize("REVIEW")).toBe(true);
    expect(service.shouldSynthesize("AGREEMENT")).toBe(true);
    expect(service.shouldSynthesize("DISAGREEMENT")).toBe(true);
    expect(service.shouldSynthesize("ANALYSIS")).toBe(true);
  });

  test("getVoiceId returns custom voice ID when provided", () => {
    const service = new VoiceService({ apiKey: "test-key", enabled: true });
    expect(service.getVoiceId("bot-alpha", "custom-voice-123")).toBe(
      "custom-voice-123",
    );
  });

  test("getVoiceId returns deterministic voice for same agent", () => {
    const service = new VoiceService({ apiKey: "test-key", enabled: true });
    const voice1 = service.getVoiceId("bot-alpha");
    const voice2 = service.getVoiceId("bot-alpha");
    expect(voice1).toBe(voice2);
    expect(typeof voice1).toBe("string");
    expect(voice1.length).toBeGreaterThan(0);
  });

  test("getVoiceId returns different voices for different agents", () => {
    const service = new VoiceService({ apiKey: "test-key", enabled: true });
    const voices = new Set<string>();
    for (let i = 0; i < 10; i++) {
      voices.add(service.getVoiceId(`bot-${i}`));
    }
    // Should use at least 2 different voices for 10 agents
    expect(voices.size).toBeGreaterThanOrEqual(2);
  });

  test("DEFAULT_VOICE_IDS contains valid entries", () => {
    const keys = Object.keys(DEFAULT_VOICE_IDS);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const key of keys) {
      const value = DEFAULT_VOICE_IDS[key];
      expect(typeof value).toBe("string");
      expect(value?.length).toBeGreaterThan(0);
    }
  });

  test("synthesize returns null when disabled", async () => {
    const service = new VoiceService({ apiKey: "", enabled: false });
    const result = await service.synthesize("Hello world", "voice-id");
    expect(result).toBeNull();
  });

  test("synthesize calls ElevenLabs API with correct params", async () => {
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      capturedBody = (init?.body as string) ?? "";
      return new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const service = new VoiceService({ apiKey: "test-api-key", enabled: true });
    const result = await service.synthesize("Test speech", "test-voice-id");

    expect(result).not.toBeNull();
    expect(capturedUrl).toContain("api.elevenlabs.io");
    expect(capturedUrl).toContain("test-voice-id");

    const body = JSON.parse(capturedBody);
    expect(body.text).toBe("Test speech");
    expect(body.model_id).toBe("eleven_monolingual_v1");
  });

  test("synthesize truncates text over 500 chars", async () => {
    let capturedBody = "";

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = (init?.body as string) ?? "";
      return new Response(new ArrayBuffer(100));
    }) as typeof fetch;

    const service = new VoiceService({ apiKey: "test-key", enabled: true });
    const longText = "A".repeat(600);
    await service.synthesize(longText, "voice-id");

    const body = JSON.parse(capturedBody);
    expect(body.text.length).toBeLessThanOrEqual(500);
    expect(body.text.endsWith("...")).toBe(true);
  });

  test("synthesize returns null on API error", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const service = new VoiceService({ apiKey: "bad-key", enabled: true });
    const result = await service.synthesize("Hello", "voice-id");
    expect(result).toBeNull();
  });
});
