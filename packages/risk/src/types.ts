export type RiskConfig = {
  maxSlippageBps: number;
  defaultSlippageBps: number;
  maxNotionalUsd: number;
  minPoolLiquidityUsd: number;
  maxPriceDeviationBps: number;
  deadlineSeconds: number;
  restrictedGeos: string[];
  requireGeoConfirm: boolean;
  requireUserConfirmBeforeIntent: boolean;
  rejectZeroAmountMin: boolean;
  boundedApproveOnly: boolean;
};

export type RiskContext = {
  tokenIn: string;
  tokenOut?: string;
  whitelistOk: boolean;
  slippageBps: number;
  notionalUsd: number;
  poolLiquidityUsd: number;
  priceDeviationBps: number;
  amountMin: bigint;
  geoConfirmed: boolean;
  userConfirmed: boolean;
  geo?: string;
};

export type RiskVerdict = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
};
