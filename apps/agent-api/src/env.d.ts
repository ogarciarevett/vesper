type Env = CloudflareBindings & {
  CF_AI_GATEWAY_ACCOUNT_ID: string;
  CF_AI_GATEWAY_ID: string;
  CF_AIG_AUTH_TOKEN?: string;
  CF_AI_DEFAULT_MODEL?: string;
  CF_AI_MODEL_CATALOG?: string;
  CF_AI_MODEL_CHECK_TTL_MS?: string;
  OPENCLAW_GATEWAY_PASSWORD: string;
  HL_PRIVATE_KEY?: string;
  HYPERLIQUID_TESTNET?: string;
  ENABLE_CCXT_FALLBACK?: string;
  CCXT_BINANCE_API_KEY?: string;
  CCXT_BINANCE_API_SECRET?: string;
  CCXT_BINANCE_TESTNET?: string;
};
