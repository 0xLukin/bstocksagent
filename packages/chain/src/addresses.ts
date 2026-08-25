import { getAddress, type Address } from "viem";
import type { PancakeAddresses } from "./types.js";

/** BNB Smart Chain only. */
export const BSC_CHAIN_ID = 56 as const;

/**
 * PancakeSwap V3 / Smart Router on BSC.
 * Reconfirmed 2026-08-26 against:
 * - https://developer.pancakeswap.finance/contracts/v3/addresses
 * - https://docs.pancakeswap.finance/trading-tools/building-trading-agents-on-pancakeswap-v3
 * Always prefer config/pools.json; these are the same canonical values as fallback.
 */
export const PANCAKE_BSC: PancakeAddresses = {
  smartRouter: getAddress("0x13f4EA83D0bd40E75C8222255bc855a974568Dd4"),
  nfpm: getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364"),
  quoterV2: getAddress("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"),
  factory: getAddress("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
  swapRouterV3: getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14"),
  permit2: getAddress("0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768"),
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function checksum(address: string): Address {
  return getAddress(address);
}
