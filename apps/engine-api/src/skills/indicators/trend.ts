/**
 * Trend indicators - pure functions for trend-based technical analysis.
 * No external dependencies; CF Workers compatible.
 */

import type { Candle } from "@repo/types";

/**
 * Calculate Exponential Moving Average (latest value only).
 *
 * @param closes - Array of closing prices (oldest first)
 * @param period - EMA period
 * @returns Latest EMA value, or the last close if insufficient data
 */
export function calculateEMA(closes: number[], period: number): number {
  if (closes.length === 0) {
    return 0;
  }
  if (closes.length < period) {
    return closes[closes.length - 1]!;
  }

  const multiplier = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += closes[i]!;
  }
  ema /= period;

  // Apply EMA formula for subsequent values
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i]! - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Calculate Simple Moving Average (latest value only).
 *
 * @param closes - Array of closing prices (oldest first)
 * @param period - SMA period
 * @returns Latest SMA value, or the last close if insufficient data
 */
export function calculateSMA(closes: number[], period: number): number {
  if (closes.length === 0) {
    return 0;
  }
  if (closes.length < period) {
    let sum = 0;
    for (const v of closes) {
      sum += v;
    }
    return sum / closes.length;
  }

  const slice = closes.slice(-period);
  let sum = 0;
  for (const v of slice) {
    sum += v;
  }
  return sum / period;
}

/**
 * Detect support and resistance levels from candle pivot points.
 *
 * Identifies local minima (supports) and local maxima (resistances)
 * by looking for swing highs/lows over a rolling window.
 *
 * @param candles - Array of candles (oldest first)
 * @param lookback - Number of candles to consider
 * @returns Arrays of support and resistance price levels, sorted by recency
 */
export function detectSupportResistance(
  candles: Candle[],
  lookback: number,
): { supports: number[]; resistances: number[] } {
  const supports: number[] = [];
  const resistances: number[] = [];

  if (candles.length < 5) {
    return { supports, resistances };
  }

  // Use only the most recent `lookback` candles
  const slice = candles.slice(-lookback);
  const pivotWindow = 2; // candles on each side to confirm a pivot

  for (let i = pivotWindow; i < slice.length - pivotWindow; i++) {
    const current = slice[i]!;

    // Check for swing high (resistance)
    let isSwingHigh = true;
    for (let j = 1; j <= pivotWindow; j++) {
      if (
        slice[i - j]!.high >= current.high ||
        slice[i + j]!.high >= current.high
      ) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      resistances.push(current.high);
    }

    // Check for swing low (support)
    let isSwingLow = true;
    for (let j = 1; j <= pivotWindow; j++) {
      if (
        slice[i - j]!.low <= current.low ||
        slice[i + j]!.low <= current.low
      ) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      supports.push(current.low);
    }
  }

  return { supports, resistances };
}
