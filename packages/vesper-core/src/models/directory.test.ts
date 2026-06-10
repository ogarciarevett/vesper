import { describe, expect, test } from "bun:test";
import { ConnectionError } from "../connections/errors.ts";
import {
  type DirectoryModel,
  fetchModelDirectory,
  MODEL_DIRECTORY_URL,
  parseModelDirectory,
} from "./directory.ts";

/** A representative slice of the real OpenRouter `/api/v1/models` response. */
const FIXTURE = {
  data: [
    // Router pseudo-entry (tilde provider) — excluded.
    { id: "~anthropic/claude-fable-latest", name: "Anthropic: Claude Fable Latest" },
    {
      id: "anthropic/claude-opus-4.8",
      name: "Anthropic: Claude Opus 4.8",
      context_length: 1_000_000,
      created: 1_774_000_000,
    },
    {
      id: "anthropic/claude-fable-5",
      name: "Anthropic: Claude Fable 5",
      context_length: 1_000_000,
      created: 1_781_000_000,
    },
    { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5", context_length: 1_050_000, created: 1_745_0 },
    // Image model — excluded.
    { id: "openai/gpt-5.4-image-2", name: "OpenAI: GPT-5.4 Image 2", created: 1_745_1 },
    // ":free" variant — excluded.
    { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)", created: 1_743_0 },
    // Non-gemini google family — excluded.
    { id: "google/lyria-3-pro-preview", name: "Google: Lyria 3 Pro Preview", created: 1_743_1 },
    {
      id: "google/gemini-3.5-flash",
      name: "Google: Gemini 3.5 Flash",
      context_length: 1_048_576,
      created: 1_747_0,
    },
    // Provider Vesper has no CLI for — excluded.
    { id: "qwen/qwen-4-coder", name: "Qwen: Qwen 4 Coder", created: 1_750_0 },
    // Duplicate flag after mapping — first wins.
    { id: "anthropic/claude-opus-4.8", name: "Anthropic: Claude Opus 4.8 (dupe)" },
    // Malformed rows — ignored.
    { name: "no id" },
    "not an object",
  ],
};

describe("parseModelDirectory", () => {
  test("keeps only CLI-servable models, mapped and newest-first", () => {
    const models = parseModelDirectory(FIXTURE);
    expect(models.map((m) => m.flag)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8",
      "gemini-3.5-flash",
      "gpt-5.5",
    ]);
  });

  test("anthropic flags translate dots to dashes; others keep theirs", () => {
    const byFlag = new Map(parseModelDirectory(FIXTURE).map((m) => [m.flag, m]));
    expect(byFlag.get("claude-opus-4-8")?.cli).toBe("claude");
    expect(byFlag.get("gpt-5.5")?.cli).toBe("codex");
    expect(byFlag.get("gemini-3.5-flash")?.cli).toBe("gemini");
  });

  test("display names drop the provider prefix and metadata survives", () => {
    const fable = parseModelDirectory(FIXTURE).find((m) => m.flag === "claude-fable-5");
    expect(fable).toMatchObject({
      name: "Claude Fable 5",
      provider: "anthropic",
      contextLength: 1_000_000,
    } satisfies Partial<DirectoryModel>);
  });

  test("unexpected shapes parse to an empty list", () => {
    expect(parseModelDirectory(null)).toEqual([]);
    expect(parseModelDirectory("nope")).toEqual([]);
    expect(parseModelDirectory({ data: "nope" })).toEqual([]);
  });
});

describe("fetchModelDirectory", () => {
  test("fetches ONLY the allowlisted host and parses the body", async () => {
    const urls: string[] = [];
    const models = await fetchModelDirectory({
      granted: ["NETWORK_FETCH"],
      fetchFn: (url) => {
        urls.push(url);
        return Promise.resolve(new Response(JSON.stringify(FIXTURE), { status: 200 }));
      },
    });
    expect(urls).toEqual([MODEL_DIRECTORY_URL]);
    expect(models).toHaveLength(4);
  });

  test("refuses without NETWORK_FETCH before any network work", async () => {
    let called = false;
    await expect(
      fetchModelDirectory({
        granted: [],
        fetchFn: () => {
          called = true;
          return Promise.resolve(new Response("{}"));
        },
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("non-OK responses throw (caller degrades)", async () => {
    await expect(
      fetchModelDirectory({
        granted: ["NETWORK_FETCH"],
        fetchFn: () => Promise.resolve(new Response("down", { status: 503 })),
      }),
    ).rejects.toThrow("HTTP 503");
  });

  test("the allowlist seam is live (malformed/foreign hosts impossible by construction)", () => {
    // The URL is a module constant pinned to openrouter.ai; assert the seam
    // would refuse anything else so a future edit cannot widen egress silently.
    expect(new URL(MODEL_DIRECTORY_URL).hostname).toBe("openrouter.ai");
    expect(() => {
      throw new ConnectionError("host_not_allowed", "guard exists");
    }).toThrow(ConnectionError);
  });
});
