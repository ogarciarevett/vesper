/**
 * Volume indicators - pure functions for volume-based technical analysis.
 * No external dependencies; CF Workers compatible.
 */

import type { Candle } from "@repo/types";

/**
 * Calculate Volume Weighted Average Price (VWAP).
 *
 * @param candles - Array of candles for the session (oldest first)
 * @returns VWAP value, or 0 if no candles
 */
export function calculateVWAP(candles: Candle[]): number {
  if (candles.length === 0) {
    return 0;
  }

  let cumulativeTPV = 0; // cumulative (typical price * volume)
  let cumulativeVolume = 0;

  for (const candle of candles) {
    if (candle.volume === 0) continue;
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTPV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
  }

  if (cumulativeVolume === 0) {
    // All candles had zero volume; return last close
    return candles[candles.length - 1]!.close;
  }

  return cumulativeTPV / cumulativeVolume;
}

/**
 * Calculate a volume profile -- distribution of volume across price bins.
 *
 * @param candles - Array of candles (oldest first)
 * @param bins - Number of price bins
 * @returns Array of { price, volume } sorted by price ascending
 */
export function calculateVolumeProfile(
  candles: Candle[],
  bins: number,
): { price: number; volume: number }[] {
  if (candles.length === 0 || bins <= 0) {
    return [];
  }

  // Find price range
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;

  for (const candle of candles) {
    if (candle.low < minPrice) minPrice = candle.low;
    if (candle.high > maxPrice) maxPrice = candle.high;
  }

  if (minPrice === maxPrice) {
    return [{ price: minPrice, volume: candles.reduce((s, c) => s + c.volume, 0) }];
  }

  const binSize = (maxPrice - minPrice) / bins;
  const profile: { price: number; volume: number }[] = [];

  for (let i = 0; i < bins; i++) {
    profile.push({
      price: minPrice + binSize * (i + 0.5), // bin center
      volume: 0,
    });
  }

  // Distribute each candle's volume across the bins it spans
  for (const candle of candles) {
    if (candle.volume === 0) continue;

    const candleMid = (candle.high + candle.low) / 2;
    const binIndex = Math.min(
      Math.floor((candleMid - minPrice) / binSize),
      bins - 1,
    );
    profile[binIndex]!.volume += candle.volume;
  }

  return profile;
}

/**
 * Detect whether recent volume represents a volume expansion
 * relative to the average volume over the given candle set.
 *
 * @param candles - Array of candles (oldest first); last candle is "recent"
 * @param multiplier - Volume must exceed average * multiplier to be considered expansion
 * @returns true if latest candle volume exceeds threshold
 */
export function isVolumeExpansion(
  candles: Candle[],
  multiplier: number,
): boolean {
  if (candles.length < 2) {
    return false;
  }

  // Average volume of all candles except the last
  let totalVolume = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    totalVolume += candles[i]!.volume;
  }
  const avgVolume = totalVolume / (candles.length - 1);

  if (avgVolume === 0) {
    return false;
  }

  const lastVolume = candles[candles.length - 1]!.volume;
  return lastVolume > avgVolume * multiplier;
}
