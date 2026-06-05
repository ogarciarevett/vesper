/**
 * Sentence chunking for streamed TTS. The brain (the user's CLI) returns a reply
 * as text; speaking it sentence-by-sentence lets the first words start playing
 * before the whole reply is ready, and gives barge-in a natural seam between
 * sentences. The same primitive serves a one-shot batch reply (one emission) and
 * a future token stream (many emissions) — see {@link streamSentences}.
 *
 * The rule is intentionally simple: a sentence ends at a run of `.`/`!`/`?`
 * followed by whitespace, or at a hard newline. A terminator at the very end of
 * the available buffer is left pending (we cannot yet tell if more text follows),
 * so abbreviations like "e.g. " may break a sentence early — acceptable for v1.
 */

const TERMINATORS = new Set([".", "!", "?"]);

/**
 * Pull every complete sentence out of `buffer`, returning them plus the trailing
 * fragment that is not yet known to be complete. Pure and allocation-light so both
 * the sync and streaming entry points share one boundary definition.
 */
function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === "\n") {
      const seg = buffer.slice(start, i).trim();
      if (seg.length > 0) sentences.push(seg);
      start = i + 1;
      i += 1;
      continue;
    }
    if (ch !== undefined && TERMINATORS.has(ch)) {
      let j = i + 1;
      while (j < buffer.length && TERMINATORS.has(buffer[j] as string)) j += 1;
      // Boundary only when we can see whitespace AFTER the terminator run. If the
      // run reaches the end of the buffer the boundary is still unknown — leave it
      // for `rest` so a stream can wait for the next chunk.
      const next = buffer[j];
      if (next !== undefined && /\s/.test(next)) {
        const seg = buffer.slice(start, j).trim();
        if (seg.length > 0) sentences.push(seg);
        start = j;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return { sentences, rest: buffer.slice(start) };
}

/** Split a complete reply into trimmed, non-empty sentences (batch case). */
export function splitSentences(text: string): string[] {
  const { sentences, rest } = extractSentences(text);
  const tail = rest.trim();
  return tail.length > 0 ? [...sentences, tail] : sentences;
}

/**
 * Consume a stream of reply chunks and yield each complete sentence as soon as its
 * boundary is crossed, flushing any trailing fragment when the stream ends. Works
 * unchanged whether the source emits the whole reply at once or token-by-token.
 */
export async function* streamSentences(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    const { sentences, rest } = extractSentences(buffer);
    for (const sentence of sentences) yield sentence;
    buffer = rest;
  }
  const tail = buffer.trim();
  if (tail.length > 0) yield tail;
}
