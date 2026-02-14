import type { HyperliquidClient } from "./client.js";
import type { AccountInfo, ClearinghouseState, OpenOrder, ParsedPosition } from "./types.js";

/** Fetch open orders */
export async function getOpenOrders(client: HyperliquidClient): Promise<OpenOrder[]> {
  const address = client.getWalletAddress();
  return client.infoRequest<OpenOrder[]>({
    type: "openOrders",
    user: address,
  });
}

/** Fetch user positions */
export async function getPositions(client: HyperliquidClient): Promise<ParsedPosition[]> {
  // Clearinghouse state gives full account details including positions
  const info = await getClearinghouseState(client);
  
  // Transform raw positions to parsed positions (Simplified for now, casting any)
  // In reality, we should map AssetPosition to ParsedPosition
  return info.assetPositions.map((p: any) => ({
    coin: p.position.coin,
    side: parseFloat(p.position.szi) > 0 ? "long" : "short",
    size: Math.abs(parseFloat(p.position.szi)),
    entryPrice: parseFloat(p.position.entryPx),
    positionValue: parseFloat(p.position.positionValue),
    unrealizedPnl: parseFloat(p.position.unrealizedPnl),
    returnOnEquity: parseFloat(p.position.returnOnEquity),
    liquidationPrice: p.position.liquidationPx ? parseFloat(p.position.liquidationPx) : null,
    leverage: p.position.leverage.value,
    leverageType: p.position.leverage.type,
    marginUsed: parseFloat(p.position.positionValue) / p.position.leverage.value // Approx
  }));
}

/** Fetch full account info (clearinghouse state) */
export async function getClearinghouseState(client: HyperliquidClient): Promise<ClearinghouseState> {
  const address = client.getWalletAddress();
  return client.infoRequest<ClearinghouseState>({
    type: "clearinghouseState",
    user: address,
  });
}

/** Fetch parsed account info */
export async function getAccountInfo(client: HyperliquidClient): Promise<AccountInfo> {
  const state = await getClearinghouseState(client);
  const positions = await getPositions(client); // Re-use the parsing logic from getPositions (which calls getClearinghouseState again - inefficient but fine for now, or optimise)

  // Better: parse here
  return {
    equity: parseFloat(state.marginSummary.accountValue),
    totalPositionValue: parseFloat(state.marginSummary.totalNtlPos),
    totalRawUsd: parseFloat(state.marginSummary.totalRawUsd),
    totalMarginUsed: parseFloat(state.marginSummary.totalMarginUsed),
    withdrawable: parseFloat(state.withdrawable),
    positions
  };
}

