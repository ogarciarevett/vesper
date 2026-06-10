import { describe, expect, test } from "bun:test";
import { stripForSpeech } from "./speech.ts";

// Only the pure text cleaner is unit-tested here; speakText/stopSpeaking are
// browser behavior (Audio + speechSynthesis) verified manually in the app.
describe("stripForSpeech", () => {
  test("drops fenced code blocks entirely (language tag included)", () => {
    const input = "Run it like this:\n```ts\nconst x = 1;\nconsole.log(x);\n```\nDone.";
    expect(stripForSpeech(input)).toBe("Run it like this:\n\nDone.");
  });

  test("drops a dangling unterminated fence line", () => {
    expect(stripForSpeech("before\n```bash\nafter")).toBe("before\n\nafter");
  });

  test("strips inline backticks but keeps the code text", () => {
    expect(stripForSpeech("Use `vesper status` to check.")).toBe("Use vesper status to check.");
  });

  test("strips heading hashes but keeps the heading text", () => {
    expect(stripForSpeech("# Plan\n## Step one\nDo the thing.")).toBe(
      "Plan\nStep one\nDo the thing.",
    );
  });

  test("links keep their label, never the URL", () => {
    expect(stripForSpeech("See [the docs](https://example.com/docs) for more.")).toBe(
      "See the docs for more.",
    );
  });

  test("strips emphasis and bold stars", () => {
    expect(stripForSpeech("This is *important* and **very bold**.")).toBe(
      "This is important and very bold.",
    );
  });

  test("strips blockquote markers", () => {
    expect(stripForSpeech("> quoted line")).toBe("quoted line");
  });

  test("collapses leftover blank runs and trims", () => {
    expect(stripForSpeech("\n\nHello\n\n\n\nworld\n\n")).toBe("Hello\n\nworld");
  });

  test("plain text passes through unchanged", () => {
    expect(stripForSpeech("All done. Two files changed.")).toBe("All done. Two files changed.");
  });
});
