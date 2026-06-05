import { describe, expect, test } from "bun:test";
import { splitSentences, streamSentences } from "./chunker.ts";

/** Collect an async iterable into an array. */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** Yield each chunk as a separate emission, simulating a streamed reply. */
async function* fromChunks(chunks: readonly string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

describe("splitSentences", () => {
  test("splits on terminators and keeps them attached", () => {
    expect(splitSentences("Hello world. How are you?")).toEqual(["Hello world.", "How are you?"]);
  });

  test("returns the whole text when there is no terminator", () => {
    expect(splitSentences("just some text")).toEqual(["just some text"]);
  });

  test("treats newlines as hard boundaries and drops empty segments", () => {
    expect(splitSentences("Line one\nLine two\n\n")).toEqual(["Line one", "Line two"]);
  });

  test("keeps runs of terminators together", () => {
    expect(splitSentences("Wait!! Really?")).toEqual(["Wait!!", "Really?"]);
  });

  test("does not split a decimal with no trailing space", () => {
    expect(splitSentences("Pi is 3.14 today.")).toEqual(["Pi is 3.14 today."]);
  });

  test("returns no sentences for empty/whitespace input", () => {
    expect(splitSentences("   \n  ")).toEqual([]);
  });
});

describe("streamSentences", () => {
  test("emits a sentence as soon as its boundary is crossed, before completion", async () => {
    const sentences = await collect(
      streamSentences(fromChunks(["Hello wor", "ld. How ", "are you?"])),
    );
    expect(sentences).toEqual(["Hello world.", "How are you?"]);
  });

  test("flushes a trailing fragment with no terminator at end of stream", async () => {
    const sentences = await collect(streamSentences(fromChunks(["Partial reply"])));
    expect(sentences).toEqual(["Partial reply"]);
  });

  test("a one-shot (batch) reply behaves like splitSentences", async () => {
    const text = "First. Second! Third?";
    expect(await collect(streamSentences(fromChunks([text])))).toEqual(splitSentences(text));
  });

  test("does not emit a terminated sentence until it sees the following whitespace", async () => {
    // After "Done." with nothing after it yet, the boundary is unknown — it must
    // wait. Only the final flush emits it.
    const emissions: string[] = [];
    for await (const s of streamSentences(fromChunks(["Done."]))) emissions.push(s);
    expect(emissions).toEqual(["Done."]);
  });
});
