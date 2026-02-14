/**
 * Volatility indicators - pure functions for volatility-based technical analysis.
 * No external dependencies; CF Workers compatible.
 */

import type { Candle } from "@repo/types";

/**
 * Calculate Bollinger Bands.
 *
 * @param closes - Array of closing prices (oldest first)
 * @param period - Moving average period (typically 20)
 * @param stdDev - Number of standard deviations (typically 2.0)
 * @returns Upper band, middle band (SMA), and lower band
 */
export function calculateBollingerBands(
  closes: number[],
  period: number,
  stdDev: number,
): { upper: number; middle: number; lower: number } {
  if (closes.length < period) {
    const lastPrice = closes[closes.length - 1] ?? 0;
    return { upper: lastPrice, middle: lastPrice, lower: lastPrice };
  }

  // Use the most recent `period` closes
  const slice = closes.slice(-period);

  // SMA (middle band)
  let sum = 0;
  for (const v of slice) {
    sum += v;
  }
  const middle = sum / period;

  // Standard deviation
  let variance = 0;
  for (const v of slice) {
    variance += (v - middle) ** 2;
  }
  const sd = Math.sqrt(variance / period);

  return {
    upper: middle + stdDev * sd,
    middle,
    lower: middle - stdDev * sd,
  };
}

/**
 * Calculate Average True Range (ATR).
 *
 * @param candles - Array of candles (oldest first) with high, low, close
 * @param period - ATR period (typically 14)
 * @returns ATR value, or 0 if insufficient data
 */
export function calculateATR(candles: Candle[], period: number): number {
  if (candles.length < 2) {
    return 0;
  }

  // Calculate true ranges
  const trueRanges: number[] = [];

  // First TR uses just high - low (no previous close)
  trueRanges.push(candles[0]!.high - candles[0]!.low);

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const prevClose = candles[i - 1]!.close;

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    // Return simple average of available TRs
    let sum = 0;
    for (const tr of trueRanges) {
      sum += tr;
    }
    return sum / trueRanges.length;
  }

  // Initial ATR = SMA of first `period` TRs
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trueRanges[i]!;
  }
  atr /= period;

  // Wilder's smoothing for the rest
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
  }

  return atr;
}
