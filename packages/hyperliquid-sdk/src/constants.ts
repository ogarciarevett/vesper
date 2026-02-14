/** Hyperliquid mainnet API endpoints */
export const MAINNET = {
  REST_URL: "https://api.hyperliquid.xyz",
  INFO_URL: "https://api.hyperliquid.xyz/info",
  EXCHANGE_URL: "https://api.hyperliquid.xyz/exchange",
  WS_URL: "wss://api.hyperliquid.xyz/ws",
  CHAIN_ID: 1337,
} as const;

/** Hyperliquid testnet API endpoints */
export const TESTNET = {
  REST_URL: "https://api.hyperliquid-testnet.xyz",
  INFO_URL: "https://api.hyperliquid-testnet.xyz/info",
  EXCHANGE_URL: "https://api.hyperliquid-testnet.xyz/exchange",
  WS_URL: "wss://api.hyperliquid-testnet.xyz/ws",
  CHAIN_ID: 421614,
} as const;

/** Rate limit configuration per endpoint category */
export const RATE_LIMITS = {
  info: { maxTokens: 1200, refillRatePerSec: 20 },
  exchange: { maxTokens: 1200, refillRatePerSec: 20 },
  orders: { maxTokens: 10, refillRatePerSec: 10 },
} as const;

/** Max orders per batch request */
export const MAX_BATCH_ORDERS = 20;

/** Max websocket subscriptions per connection */
export const MAX_WS_SUBSCRIPTIONS = 100;

/** EIP-712 domain for mainnet */
export const EIP712_DOMAIN_MAINNET = {
  name: "Exchange",
  version: "1",
  chainId: MAINNET.CHAIN_ID,
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
} as const;

/** EIP-712 domain for testnet */
export const EIP712_DOMAIN_TESTNET = {
  name: "Exchange",
  version: "1",
  chainId: TESTNET.CHAIN_ID,
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
} as const;

/** Common trading pairs available on Hyperliquid */
export const SUPPORTED_PAIRS = [
  "BTC",
  "ETH",
  "SOL",
  "DOGE",
  "ARB",
  "OP",
  "AVAX",
  "MATIC",
  "SUI",
  "APT",
  "SEI",
  "TIA",
  "INJ",
  "LINK",
  "WLD",
  "NEAR",
  "FIL",
  "ATOM",
  "FTM",
  "RUNE",
] as const;

/** Valid candle intervals */
export const CANDLE_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const;

export type CandleInterval = (typeof CANDLE_INTERVALS)[number];
