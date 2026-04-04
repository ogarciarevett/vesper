/**
 * Firecrawl REST API client for scraping Polymarket data.
 * Uses the Firecrawl v1 scrape endpoint directly (no MCP stdio transport).
 */

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1/scrape";

export interface PolymarketOdds {
  yes: number;
  no: number;
  volume24h: number | null;
}

/**
 * Scrape a Polymarket event page and extract odds data.
 * Falls back to null if scraping or parsing fails.
 */
export async function scrapePolymarket(
  apiKey: string,
  marketSlug: string,
): Promise<PolymarketOdds | null> {
  try {
    const response = await fetch(FIRECRAWL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: `https://polymarket.com/event/${marketSlug}`,
        formats: ["markdown"],
        waitFor: 3000,
      }),
    });

    if (!response.ok) {
      console.error(`Firecrawl scrape failed: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      success: boolean;
      data?: { markdown?: string };
    };

    if (!data.success || !data.data?.markdown) {
      return null;
    }

    return parseOddsFromMarkdown(data.data.markdown);
  } catch (err) {
    console.error("Firecrawl scrape error:", err);
    return null;
  }
}

/**
 * Parse Polymarket odds from scraped markdown content.
 * Looks for patterns like "Yes 65%" / "No 35%" or "65¢" / "35¢" pricing.
 */
export function parseOddsFromMarkdown(md: string): PolymarketOdds | null {
  // Try "Yes XX%" / "No YY%" patterns
  const yesMatch = md.match(/[Yy]es\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*%/);
  const noMatch = md.match(/[Nn]o\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*%/);

  if (yesMatch) {
    const yes = Number.parseFloat(yesMatch[1]!);
    const no = noMatch ? Number.parseFloat(noMatch[1]!) : 100 - yes;
    const volumeMatch = md.match(/\$[\d,]+(?:\.\d+)?[MKB]?\s*(?:Vol|Volume|24h)/i);
    return {
      yes,
      no,
      volume24h: volumeMatch ? parseVolumeString(volumeMatch[0]) : null,
    };
  }

  // Try cent-based pricing (65¢ = 65%)
  const centMatch = md.match(/(\d+(?:\.\d+)?)\s*¢/);
  if (centMatch) {
    const yes = Number.parseFloat(centMatch[1]!);
    return { yes, no: 100 - yes, volume24h: null };
  }

  // Try decimal odds (0.65 / 0.35)
  const decimalMatch = md.match(/(?:Yes|Buy)\s*[:\-]?\s*(?:\$)?(0\.\d+)/i);
  if (decimalMatch) {
    const yes = Number.parseFloat(decimalMatch[1]!) * 100;
    return { yes, no: 100 - yes, volume24h: null };
  }

  return null;
}

function parseVolumeString(raw: string): number | null {
  const numMatch = raw.match(/([\d,]+(?:\.\d+)?)\s*([MKB])?/);
  if (!numMatch) return null;
  let value = Number.parseFloat(numMatch[1]!.replace(/,/g, ""));
  const suffix = numMatch[2];
  if (suffix === "M") value *= 1_000_000;
  else if (suffix === "K") value *= 1_000;
  else if (suffix === "B") value *= 1_000_000_000;
  return value;
}
