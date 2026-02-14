import type { HyperliquidClient } from "./client.js";
import { MAX_BATCH_ORDERS } from "./constants.js";
import type {
  CancelOrderParams,
  ClosePositionParams,
  ExchangeResponse,
  ModifyOrderParams,
  OrderWire,
  PlaceOrderParams,
  PlaceTriggerOrderParams,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLimitOrderWire(
  assetIndex: number,
  params: PlaceOrderParams,
): OrderWire {
  const tif = params.timeInForce ?? "Gtc";
  return {
    a: assetIndex,
    b: params.isBuy,
    p: params.price.toString(),
    s: params.size.toString(),
    r: params.reduceOnly ?? false,
    t: { limit: { tif } },
    ...(params.cloid ? { c: params.cloid } : {}),
  };
}

function buildTriggerOrderWire(
  assetIndex: number,
  params: PlaceTriggerOrderParams,
): OrderWire {
  return {
    a: assetIndex,
    b: params.isBuy,
    p: params.triggerPrice.toString(), // for trigger orders, p is triggerPx
    s: params.size.toString(),
    r: params.reduceOnly ?? true,
    t: {
      trigger: {
        isMarket: params.isMarket,
        triggerPx: params.triggerPrice.toString(),
        tpsl: params.tpsl,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Order operations
// ---------------------------------------------------------------------------

/** Place one or more limit/market orders */
export async function placeOrders(
  client: HyperliquidClient,
  orders: PlaceOrderParams[],
): Promise<ExchangeResponse> {
  if (orders.length === 0) {
    throw new Error("At least one order is required");
  }
  if (orders.length > MAX_BATCH_ORDERS) {
    throw new Error(`Max ${MAX_BATCH_ORDERS} orders per batch`);
  }

  const wires: OrderWire[] = [];
  for (const params of orders) {
    const assetIndex = await client.getAssetIndex(params.coin);
    wires.push(buildLimitOrderWire(assetIndex, params));
  }

  return client.exchangeRequest({
    type: "order",
    orders: wires,
    grouping: "na",
  });
}

/** Place one or more trigger (stop-loss / take-profit) orders */
export async function placeTriggerOrders(
  client: HyperliquidClient,
  orders: PlaceTriggerOrderParams[],
): Promise<ExchangeResponse> {
  if (orders.length === 0) {
    throw new Error("At least one trigger order is required");
  }
  if (orders.length > MAX_BATCH_ORDERS) {
    throw new Error(`Max ${MAX_BATCH_ORDERS} orders per batch`);
  }

  const wires: OrderWire[] = [];
  for (const params of orders) {
    const assetIndex = await client.getAssetIndex(params.coin);
    wires.push(buildTriggerOrderWire(assetIndex, params));
  }

  return client.exchangeRequest({
    type: "order",
    orders: wires,
    grouping: "na",
  });
}

/** Cancel one or more orders by order ID */
export async function cancelOrders(
  client: HyperliquidClient,
  cancels: CancelOrderParams[],
): Promise<ExchangeResponse> {
  if (cancels.length === 0) {
    throw new Error("At least one cancel is required");
  }

  const cancelsWire: { a: number; o: number }[] = [];
  for (const c of cancels) {
    const assetIndex = await client.getAssetIndex(c.coin);
    cancelsWire.push({ a: assetIndex, o: c.orderId });
  }

  return client.exchangeRequest({
    type: "cancel",
    cancels: cancelsWire,
  });
}

/** Modify one or more existing orders (atomic cancel + replace) */
export async function modifyOrders(
  client: HyperliquidClient,
  mods: ModifyOrderParams[],
): Promise<ExchangeResponse> {
  if (mods.length === 0) {
    throw new Error("At least one modification is required");
  }

  const modifiesWire: { oid: number; order: OrderWire }[] = [];
  for (const m of mods) {
    const assetIndex = await client.getAssetIndex(m.coin);
    modifiesWire.push({
      oid: m.orderId,
      order: buildLimitOrderWire(assetIndex, {
        coin: m.coin,
        isBuy: m.isBuy,
        price: m.price,
        size: m.size,
        reduceOnly: m.reduceOnly,
        orderType: m.orderType,
        timeInForce: m.timeInForce,
      }),
    });
  }

  return client.exchangeRequest({
    type: "batchModify",
    modifies: modifiesWire,
  });
}

/** Close a position (fully or partially). If no price is given, uses market order. */
export async function closePosition(
  client: HyperliquidClient,
  params: ClosePositionParams,
): Promise<ExchangeResponse> {
  // Fetch current position to determine side and size
  const positions = await client.getPositions();
  const pos = positions.find((p) => p.coin === params.coin);
  if (!pos) {
    throw new Error(`No open position found for ${params.coin}`);
  }

  const closeSize = params.size ?? pos.size;
  const isBuy = pos.side === "short"; // close short = buy, close long = sell

  if (params.price) {
    // Limit close
    return client.placeOrder({
      coin: params.coin,
      isBuy,
      price: params.price,
      size: closeSize,
      reduceOnly: true,
      orderType: "limit",
      timeInForce: "Gtc",
    });
  }

  // Market close -- use a very aggressive limit price to simulate market
  // Hyperliquid doesn't have a native market order; use IOC with aggressive price
  const mids = await client.getAllMids();
  const mid = mids[params.coin];
  if (!mid) {
    throw new Error(`Cannot determine mid price for ${params.coin}`);
  }
  const midPrice = Number.parseFloat(mid);
  // Set price 5% away from mid to ensure fill
  const aggressivePrice = isBuy ? midPrice * 1.05 : midPrice * 0.95;

  return client.placeOrder({
    coin: params.coin,
    isBuy,
    price: aggressivePrice,
    size: closeSize,
    reduceOnly: true,
    orderType: "limit",
    timeInForce: "Ioc",
  });
}

/** Update leverage for an asset */
export async function updateLeverage(
  client: HyperliquidClient,
  coin: string,
  leverage: number,
  isCross: boolean,
): Promise<ExchangeResponse> {
  const assetIndex = await client.getAssetIndex(coin);
  return client.exchangeRequest({
    type: "updateLeverage",
    asset: assetIndex,
    isCross,
    leverage,
  });
}
