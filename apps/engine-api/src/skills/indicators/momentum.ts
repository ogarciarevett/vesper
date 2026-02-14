/**
 * Momentum indicators - pure functions for momentum-based technical analysis.
 * No external dependencies; CF Workers compatible.
 */

/**
 * Calculate Relative Strength Index (RSI).
 * Uses Wilder's smoothing method (exponential moving average of gains/losses).
 *
 * @param closes - Array of closing prices (oldest first)
 * @param period - RSI period (typically 14)
 * @returns RSI value between 0 and 100, or 50 if insufficient data
 */
export function calculateRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) {
    return 50; // neutral when insufficient data
  }

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss over the first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) {
      avgGain += change;
    } else {
      avgLoss += Math.abs(change);
    }
  }

  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for the remaining data
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Calculate MACD (Moving Average Convergence Divergence).
 *
 * @param closes - Array of closing prices (oldest first)
 * @param fastPeriod - Fast EMA period (typically 12)
 * @param slowPeriod - Slow EMA period (typically 26)
 * @param signalPeriod - Signal line EMA period (typically 9)
 * @returns MACD line, signal line, and histogram values
 */
export function calculateMACD(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): { macd: number; signal: number; histogram: number } {
  if (closes.length < slowPeriod + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  // Calculate full EMA series for fast and slow
  const fastEMAs = calculateEMASeries(closes, fastPeriod);
  const slowEMAs = calculateEMASeries(closes, slowPeriod);

  // MACD line = fast EMA - slow EMA (aligned from slowPeriod onwards)
  const macdLine: number[] = [];
  const offset = slowPeriod - fastPeriod;
  for (let i = 0; i < slowEMAs.length; i++) {
    macdLine.push(fastEMAs[i + offset]! - slowEMAs[i]!);
  }

  if (macdLine.length < signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  // Signal line = EMA of MACD line
  const signalEMAs = calculateEMASeries(macdLine, signalPeriod);
  const macdValue = macdLine[macdLine.length - 1]!;
  const signalValue = signalEMAs[signalEMAs.length - 1]!;

  return {
    macd: macdValue,
    signal: signalValue,
    histogram: macdValue - signalValue,
  };
}

/**
 * Calculate Rate of Change (ROC) as a percentage.
 *
 * @param closes - Array of closing prices (oldest first)
 * @param period - Lookback period
 * @returns ROC as a percentage, or 0 if insufficient data
 */
export function calculateROC(closes: number[], period: number): number {
  if (closes.length < period + 1) {
    return 0;
  }

  const current = closes[closes.length - 1]!;
  const previous = closes[closes.length - 1 - period]!;

  if (previous === 0) {
    return 0;
  }

  return ((current - previous) / previous) * 100;
}

/**
 * Helper: Calculate a full EMA series from an array of values.
 * The first EMA value is seeded with the SMA over the period.
 */
function calculateEMASeries(values: number[], period: number): number[] {
  if (values.length < period) {
    return [];
  }

  const multiplier = 2 / (period + 1);
  const result: number[] = [];

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i]!;
  }
  result.push(sum / period);

  // EMA for subsequent values
  for (let i = period; i < values.length; i++) {
    const prev = result[result.length - 1]!;
    result.push((values[i]! - prev) * multiplier + prev);
  }

  return result;
}
