/** token1 raw for a token0 raw amount at the current sqrt price (Q64.96). */
export function amount1FromAmount0(amount0: bigint, sqrtPriceX96: bigint): bigint {
  if (amount0 <= 0n || sqrtPriceX96 <= 0n) return 0n;
  return (amount0 * sqrtPriceX96 * sqrtPriceX96) / 2n ** 192n;
}

export function amount0FromAmount1(amount1: bigint, sqrtPriceX96: bigint): bigint {
  if (amount1 <= 0n || sqrtPriceX96 <= 0n) return 0n;
  return (amount1 * 2n ** 192n) / (sqrtPriceX96 * sqrtPriceX96);
}
