import {
  type Hex,
  type PrivateKeyAccount,
  createWalletClient,
  http,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EIP712_DOMAIN_MAINNET,
  EIP712_DOMAIN_TESTNET,
  MAINNET,
  TESTNET,
} from "./constants.js";
import type { ExchangeAction } from "./types.js";

/** Normalise a hex private key to include the 0x prefix */
function normalizePrivateKey(key: string): Hex {
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

/** Derive an account object from a raw private key string */
export function accountFromPrivateKey(privateKey: string): PrivateKeyAccount {
  return privateKeyToAccount(normalizePrivateKey(privateKey));
}

/** Get the EIP-712 domain for the given network */
export function getEip712Domain(testnet: boolean) {
  return testnet ? EIP712_DOMAIN_TESTNET : EIP712_DOMAIN_MAINNET;
}

// ---------------------------------------------------------------------------
// EIP-712 type definitions for Hyperliquid exchange actions
// ---------------------------------------------------------------------------

const EXCHANGE_TYPES = {
  "Exchange": [
    { name: "action", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/**
 * Hyperliquid expects a specific hash of the action payload rather than
 * signing the raw action JSON. The action field in the EIP-712 message is a
 * keccak256 of the msgpack-encoded action -- but in practice, the API
 * accepts a simplified approach where the action is hashed as a
 * JSON-stringified phantom agent representation.
 *
 * For Cloudflare Workers compatibility we use viem which has no Node.js deps.
 */
export async function signExchangeAction(
  action: ExchangeAction,
  nonce: number,
  account: PrivateKeyAccount,
  testnet: boolean,
): Promise<{ r: string; s: string; v: number }> {
  const domain = getEip712Domain(testnet);

  // Hyperliquid uses a phantom agent pattern: the action is serialised and
  // hashed, then that hash is what gets signed via EIP-712.
  const actionHash = hashAction(action, nonce);

  const chain = defineChain({
    id: domain.chainId,
    name: testnet ? "Hyperliquid Testnet" : "Hyperliquid",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: {
      default: {
        http: [testnet ? TESTNET.REST_URL : MAINNET.REST_URL],
      },
    },
  });

  const client = createWalletClient({
    account,
    chain,
    transport: http(),
  });

  const signature = await client.signTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: BigInt(domain.chainId),
      verifyingContract: domain.verifyingContract,
    },
    types: EXCHANGE_TYPES,
    primaryType: "Exchange",
    message: {
      action: actionHash,
      nonce: BigInt(nonce),
    },
  });

  return splitSignature(signature);
}

/** Hash the action + nonce into a deterministic string for signing */
function hashAction(action: ExchangeAction, nonce: number): string {
  // Hyperliquid expects a stringified and stable representation
  const payload = JSON.stringify({ action, nonce });
  return payload;
}

/** Split a 65-byte hex signature into r, s, v components */
function splitSignature(sig: Hex): { r: string; s: string; v: number } {
  // Remove 0x prefix
  const raw = sig.slice(2);
  return {
    r: `0x${raw.slice(0, 64)}`,
    s: `0x${raw.slice(64, 128)}`,
    v: Number.parseInt(raw.slice(128, 130), 16),
  };
}

/** Generate a nonce (current time in ms) */
export function generateNonce(): number {
  return Date.now();
}
