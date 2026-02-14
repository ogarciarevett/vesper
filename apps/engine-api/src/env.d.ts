type Env = CloudflareBindings & {
  CLOUDFLARE_AI_GATEWAY_API_KEY: string;
  CF_AI_GATEWAY_ACCOUNT_ID: string;
  CF_AI_GATEWAY_GATEWAY_ID: string;
  HL_PRIVATE_KEY?: string; // Optional for read-only bots
  HYPERLIQUID_TESTNET?: string;
};
