import type { HyperliquidClient } from "./client.js";
import type { CandleInterval } from "./constants.js";
import type {
  AllMidsResponse,
  FundingEntry,
  L2BookResponse,
  PredictedFunding,
  RawCandle,
  RawTrade,
  UniverseMeta,
} from "./types.js";

/** Fetch metadata about all available assets */
export async function getMeta(client: HyperliquidClient): Promise<UniverseMeta> {
  return client.infoRequest<UniverseMeta>({ type: "meta" });
}

/** Fetch current mid prices for all assets */
export async function getAllMids(
  client: HyperliquidClient,
): Promise<AllMidsResponse> {
  return client.infoRequest<AllMidsResponse>({ type: "allMids" });
}

/** Fetch L2 order book for a coin */
export async function getL2Book(
  client: HyperliquidClient,
  coin: string,
): Promise<L2BookResponse> {
  return client.infoRequest<L2BookResponse>({ type: "l2Book", coin });
}

/** Fetch recent trades for a coin */
export async function getRecentTrades(
  client: HyperliquidClient,
  coin: string,
): Promise<RawTrade[]> {
  return client.infoRequest<RawTrade[]>({ type: "recentTrades", coin });
}

/** Fetch candle/OHLCV data */
export async function getCandles(
  client: HyperliquidClient,
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
): Promise<RawCandle[]> {
  return client.infoRequest<RawCandle[]>({
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime },
  });
}

/** Fetch historical funding rates for a coin */
export async function getFundingHistory(
  client: HyperliquidClient,
  coin: string,
  startTime: number,
  endTime: number,
): Promise<FundingEntry[]> {
  return client.infoRequest<FundingEntry[]>({
    type: "fundingHistory",
    coin,
    startTime,
    endTime,
  });
}

/** Fetch predicted funding rates for all assets */
export async function getFundingRates(
  client: HyperliquidClient,
): Promise<PredictedFunding[]> {
  return client.infoRequest<PredictedFunding[]>({ type: "predictedFundings" });
}
