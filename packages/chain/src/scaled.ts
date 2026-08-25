import type { Address, PublicClient } from "viem";
import { scaledUiAbi } from "./abis.js";

/** 1.0 in ERC-8056 fixed-point. */
export const UI_MULTIPLIER_ONE = 10n ** 18n;

/**
 * Local raw↔UI conversion matching the ERC-8056 formula:
 *   UI = raw * uiMultiplier / 1e18
 *   raw = ui * 1e18 / uiMultiplier
 * Prefer on-chain toUIAmount / fromUIAmount for live calls (contract rounding).
 * Never pass UI amounts into approve / swap / mint.
 */
export function convertRawToUi(rawAmount: bigint, uiMultiplier: bigint): bigint {
  if (uiMultiplier <= 0n) throw new Error("uiMultiplier must be > 0");
  return (rawAmount * uiMultiplier) / UI_MULTIPLIER_ONE;
}

export function convertUiToRaw(uiAmount: bigint, uiMultiplier: bigint): bigint {
  if (uiMultiplier <= 0n) throw new Error("uiMultiplier must be > 0");
  return (uiAmount * UI_MULTIPLIER_ONE) / uiMultiplier;
}

export function formatFixed(amount: bigint, decimals: number, maxFrac = 8): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0");
  frac = frac.replace(/0+$/, "").slice(0, maxFrac);
  const body = frac.length ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function parseFixed(display: string, decimals: number): bigint {
  const trimmed = display.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount: ${display}`);
  }
  const neg = trimmed.startsWith("-");
  const [w, f = ""] = (neg ? trimmed.slice(1) : trimmed).split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const raw = BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -raw : raw;
}

export async function readUiMultiplier(
  client: PublicClient,
  token: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: scaledUiAbi,
    functionName: "uiMultiplier",
  });
}

export async function toUIAmount(
  client: PublicClient,
  token: Address,
  rawAmount: bigint,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: scaledUiAbi,
    functionName: "toUIAmount",
    args: [rawAmount],
  });
}

export async function fromUIAmount(
  client: PublicClient,
  token: Address,
  uiAmount: bigint,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: scaledUiAbi,
    functionName: "fromUIAmount",
    args: [uiAmount],
  });
}

export async function balanceOfUI(
  client: PublicClient,
  token: Address,
  account: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: scaledUiAbi,
    functionName: "balanceOfUI",
    args: [account],
  });
}

export async function tryScaled(
  client: PublicClient,
  token: Address,
): Promise<{ supported: boolean; uiMultiplier?: bigint }> {
  try {
    const uiMultiplier = await readUiMultiplier(client, token);
    return { supported: uiMultiplier > 0n, uiMultiplier };
  } catch {
    return { supported: false };
  }
}
