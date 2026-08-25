/** Uniswap / Pancake V3 tick math and liquidity amounts. Integer only. */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
export const Q96 = 2n ** 96n;

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick ${tick} out of range`);
  }
  const absTick = tick < 0 ? -tick : tick;
  let ratio =
    (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function orderSqrt(a: bigint, b: bigint): [bigint, bigint] {
  return a < b ? [a, b] : [b, a];
}

export function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [low, high] = orderSqrt(sqrtA, sqrtB);
  if (low === 0n || low === high) return 0n;
  return (liquidity * Q96 * (high - low)) / high / low;
}

export function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [low, high] = orderSqrt(sqrtA, sqrtB);
  if (low === high) return 0n;
  return (liquidity * (high - low)) / Q96;
}

export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const [low, high] = orderSqrt(sqrtA, sqrtB);
  if (sqrtPriceX96 <= low) {
    return { amount0: getAmount0ForLiquidity(low, high, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 < high) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, high, liquidity),
      amount1: getAmount1ForLiquidity(low, sqrtPriceX96, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(low, high, liquidity) };
}

export function maxLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [low, high] = orderSqrt(sqrtA, sqrtB);
  if (low === 0n || low === high || amount0 <= 0n) return 0n;
  const intermediate = (low * high) / Q96;
  return (amount0 * intermediate) / (high - low);
}

export function maxLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [low, high] = orderSqrt(sqrtA, sqrtB);
  if (low === high || amount1 <= 0n) return 0n;
  return (amount1 * Q96) / (high - low);
}

export function maxLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const [low, high] = orderSqrt(sqrtA, sqrtB);
  if (sqrtPriceX96 <= low) return maxLiquidityForAmount0(low, high, amount0);
  if (sqrtPriceX96 < high) {
    const l0 = maxLiquidityForAmount0(sqrtPriceX96, high, amount0);
    const l1 = maxLiquidityForAmount1(low, sqrtPriceX96, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return maxLiquidityForAmount1(low, high, amount1);
}

/**
 * Given a range and current price, turn one or both desired amounts into the
 * liquidity that actually enters the pool, plus the amounts that liquidity uses.
 */
export function planLiquidityAmounts(args: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
}): { liquidity: bigint; amount0: bigint; amount1: bigint } {
  const sqrtA = getSqrtRatioAtTick(args.tickLower);
  const sqrtB = getSqrtRatioAtTick(args.tickUpper);
  let amount0 = args.amount0Desired;
  let amount1 = args.amount1Desired;

  if (amount0 > 0n && amount1 <= 0n) {
    const liquidity = maxLiquidityForAmount0(
      args.sqrtPriceX96 < sqrtB ? args.sqrtPriceX96 : sqrtA,
      sqrtB,
      amount0,
    );
    const used = getAmountsForLiquidity(args.sqrtPriceX96, sqrtA, sqrtB, liquidity);
    return { liquidity, amount0: used.amount0, amount1: used.amount1 };
  }
  if (amount1 > 0n && amount0 <= 0n) {
    const liquidity = maxLiquidityForAmount1(
      sqrtA,
      args.sqrtPriceX96 > sqrtA ? args.sqrtPriceX96 : sqrtB,
      amount1,
    );
    const used = getAmountsForLiquidity(args.sqrtPriceX96, sqrtA, sqrtB, liquidity);
    return { liquidity, amount0: used.amount0, amount1: used.amount1 };
  }

  const liquidity = maxLiquidityForAmounts(args.sqrtPriceX96, sqrtA, sqrtB, amount0, amount1);
  const used = getAmountsForLiquidity(args.sqrtPriceX96, sqrtA, sqrtB, liquidity);
  return { liquidity, amount0: used.amount0, amount1: used.amount1 };
}
