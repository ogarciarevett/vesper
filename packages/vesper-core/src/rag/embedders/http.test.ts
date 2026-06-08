import { describe, expect, test } from "bun:test";
import type { Capability } from "../../capabilities/index.ts";
import type { FetchFn } from "../../connections/fetch.ts";
import { makeHttpEmbedder } from "./http.ts";

const NET: readonly Capability[] = ["NETWORK_FETCH"];

/** A fetch stub that records the last call and returns the given JSON body. */
function stubFetch(
  body: unknown,
  status = 200,
): { fetchFn: FetchFn; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

describe("makeHttpEmbedder (ollama)", () => {
  test("POSTs to /api/embed and returns Float32Array vectors of the configured width", async () => {
    const { fetchFn, calls } = stubFetch({
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
    });
    const embedder = makeHttpEmbedder({
      id: "ollama:test",
      format: "ollama",
      endpoint: "http://localhost:11434/",
      model: "nomic-embed-text",
      dimensions: 3,
      allowedHosts: ["localhost"],
      granted: NET,
      fetchFn,
    });
    const out = await embedder.embed(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[0] as Float32Array)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:11434/api/embed");
    const sent = JSON.parse(String(calls[0]?.init?.body));
    expect(sent).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
  });

  test("empty input short-circuits without a network call", async () => {
    const { fetchFn, calls } = stubFetch({ embeddings: [] });
    const embedder = makeHttpEmbedder({
      id: "ollama:test",
      format: "ollama",
      endpoint: "http://localhost:11434",
      model: "m",
      dimensions: 3,
      allowedHosts: ["localhost"],
      granted: NET,
      fetchFn,
    });
    expect(await embedder.embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("makeHttpEmbedder (openai)", () => {
  test("sends a Bearer key, parses data[].embedding, and sorts by index", async () => {
    const { fetchFn, calls } = stubFetch({
      data: [
        { index: 1, embedding: [9, 9] },
        { index: 0, embedding: [1, 1] },
      ],
    });
    const embedder = makeHttpEmbedder({
      id: "openai:test",
      format: "openai",
      endpoint: "https://api.openai.com",
      model: "text-embedding-3-small",
      dimensions: 2,
      apiKey: "sk-secret",
      allowedHosts: ["api.openai.com"],
      granted: NET,
      fetchFn,
    });
    const out = await embedder.embed(["first", "second"]);
    expect(Array.from(out[0] as Float32Array)).toEqual([1, 1]);
    expect(Array.from(out[1] as Float32Array)).toEqual([9, 9]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
  });
});

describe("makeHttpEmbedder (guards)", () => {
  function embedder(
    granted: readonly Capability[],
    allowedHosts: readonly string[],
    fetchFn: FetchFn,
  ) {
    return makeHttpEmbedder({
      id: "g",
      format: "ollama",
      endpoint: "http://localhost:11434",
      model: "m",
      dimensions: 3,
      allowedHosts,
      granted,
      fetchFn,
    });
  }

  test("rejects before any network call when NETWORK_FETCH is not granted", async () => {
    const { fetchFn, calls } = stubFetch({ embeddings: [[1, 2, 3]] });
    await expect(embedder([], ["localhost"], fetchFn).embed(["a"])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("refuses a non-allowlisted host", async () => {
    const { fetchFn, calls } = stubFetch({ embeddings: [[1, 2, 3]] });
    await expect(embedder(NET, ["example.com"], fetchFn).embed(["a"])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("throws on a dimension mismatch", async () => {
    const { fetchFn } = stubFetch({ embeddings: [[1, 2]] }); // 2-dim, expected 3
    await expect(embedder(NET, ["localhost"], fetchFn).embed(["a"])).rejects.toThrow(/dim/);
  });

  test("throws on a non-ok HTTP status", async () => {
    const { fetchFn } = stubFetch({ error: "boom" }, 500);
    await expect(embedder(NET, ["localhost"], fetchFn).embed(["a"])).rejects.toThrow(/500/);
  });

  test("throws when the count of returned vectors differs from the input", async () => {
    const { fetchFn } = stubFetch({ embeddings: [[1, 2, 3]] }); // 1 vector for 2 inputs
    await expect(embedder(NET, ["localhost"], fetchFn).embed(["a", "b"])).rejects.toThrow();
  });
});
