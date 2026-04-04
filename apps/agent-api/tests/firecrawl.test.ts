import { describe, expect, test } from "bun:test";
import { parseOddsFromMarkdown } from "../src/skills/strategies/firecrawl";

describe("Firecrawl Odds Parser", () => {
  test("parses 'Yes XX%' / 'No YY%' format", () => {
    const md = "Market: Will ETH hit 5k?\nYes: 65%\nNo: 35%\nVolume: $1.2M Vol";
    const result = parseOddsFromMarkdown(md);
    expect(result).not.toBeNull();
    expect(result?.yes).toBe(65);
    expect(result?.no).toBe(35);
  });

  test("parses 'Yes XX%' without explicit No", () => {
    const md = "Probability: Yes 72%";
    const result = parseOddsFromMarkdown(md);
    expect(result).not.toBeNull();
    expect(result?.yes).toBe(72);
    expect(result?.no).toBe(28);
  });

  test("parses cent-based pricing (65¢)", () => {
    const md = "Current Price: 65¢";
    const result = parseOddsFromMarkdown(md);
    expect(result).not.toBeNull();
    expect(result?.yes).toBe(65);
    expect(result?.no).toBe(35);
  });

  test("parses decimal odds ($0.65)", () => {
    const md = "Buy Yes: $0.73";
    const result = parseOddsFromMarkdown(md);
    expect(result).not.toBeNull();
    expect(result?.yes).toBeCloseTo(73);
    expect(result?.no).toBeCloseTo(27);
  });

  test("returns null for unparseable content", () => {
    const md = "This page has no odds data at all";
    const result = parseOddsFromMarkdown(md);
    expect(result).toBeNull();
  });

  test("handles decimal percentages", () => {
    const md = "Yes: 65.5% No: 34.5%";
    const result = parseOddsFromMarkdown(md);
    expect(result).not.toBeNull();
    expect(result?.yes).toBe(65.5);
    expect(result?.no).toBe(34.5);
  });
});
