import { loadRiskConfig } from "./load.js";
import type { RiskConfig, RiskContext, RiskVerdict } from "./types.js";

const COMPLIANCE = {
  geo: "Geo not confirmed. bStocks is unavailable in the United States and restricted regions.",
  confirm: "The user has not explicitly confirmed this action. No signer intent will be created.",
  whitelist: "Token is not on the whitelist. Quote and trade refused.",
  slippage: "Slippage exceeds the risk cap.",
  size: "Notional size exceeds the per-trade cap.",
  liquidity: "Pool liquidity is below the minimum threshold.",
  deviation: "Pool price deviation vs the reference is too large.",
  amountMin: "amountMin cannot be 0.",
};

export function evaluateRisk(ctx: RiskContext, config: RiskConfig = loadRiskConfig()): RiskVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (config.requireGeoConfirm && !ctx.geoConfirmed) {
    blockers.push(COMPLIANCE.geo);
  }
  if (ctx.geo && config.restrictedGeos.map((g) => g.toUpperCase()).includes(ctx.geo.toUpperCase())) {
    blockers.push(`Restricted region ${ctx.geo}: ${COMPLIANCE.geo}`);
  }
  if (config.requireUserConfirmBeforeIntent && !ctx.userConfirmed) {
    blockers.push(COMPLIANCE.confirm);
  }
  if (!ctx.whitelistOk) {
    blockers.push(COMPLIANCE.whitelist);
  }
  if (ctx.slippageBps > config.maxSlippageBps) {
    blockers.push(`${COMPLIANCE.slippage} (${ctx.slippageBps} bps > ${config.maxSlippageBps} bps)`);
  }
  if (ctx.notionalUsd > config.maxNotionalUsd) {
    blockers.push(`${COMPLIANCE.size} ($${ctx.notionalUsd} > $${config.maxNotionalUsd})`);
  }
  if (ctx.poolLiquidityUsd > 0 && ctx.poolLiquidityUsd < config.minPoolLiquidityUsd) {
    blockers.push(`${COMPLIANCE.liquidity} ($${ctx.poolLiquidityUsd} < $${config.minPoolLiquidityUsd})`);
  }
  if (ctx.priceDeviationBps > config.maxPriceDeviationBps) {
    blockers.push(`${COMPLIANCE.deviation} (${ctx.priceDeviationBps} bps > ${config.maxPriceDeviationBps} bps)`);
  }
  if (config.rejectZeroAmountMin && ctx.amountMin <= 0n) {
    blockers.push(COMPLIANCE.amountMin);
  }
  if (ctx.slippageBps > config.defaultSlippageBps) {
    warnings.push(`Slippage ${ctx.slippageBps} bps is above the default ${config.defaultSlippageBps} bps.`);
  }
  warnings.push("This is not investment advice. The user signs and bears on-chain risk.");
  warnings.push("LP can incur impermanent loss. Certificate exposure is not direct equity.");

  return { ok: blockers.length === 0, blockers, warnings };
}

export function latchGeoConfirm(current: boolean, statement: string): boolean {
  const t = statement.toLowerCase();
  const denied = /美国|united states|\bus\b|restricted|受限/.test(t) && /是|yes|live|居住/.test(t);
  if (denied && !/不在|不是|not|no/.test(t)) return false;
  const affirmed =
    /不在美国|非美国|不是美国人|not in the (us|usa|united states)|i am not (in )?(the )?(us|usa)/i.test(
      statement,
    ) ||
    /i confirm.{0,80}not in (the )?(us|usa|united states)/i.test(statement) ||
    /确认.*非.*受限/.test(statement) ||
    /not in .{0,40}restricted/i.test(statement);
  return current || affirmed;
}

export function isUserCancel(statement: string): boolean {
  return /^(我)?(取消|不要了|算了|cancel|never mind|forget it)((这笔|本次|以上|this|the)?\s*(兑换|交易|执行|订单|报价|加池|swap|trade|quote|lp)?)?[。.!！]?$/i.test(
    statement.trim(),
  );
}

export function isUserConfirm(statement: string): boolean {
  const t = statement.trim();
  if (/^(确定|好的?|可以|行|嗯|ok|okay|yes)$/i.test(t)) return true;
  if (/^(我)?(确认|同意)(执行)?$/i.test(t)) return true;
  if (/^(confirm|proceed|go ahead|do it|yes,?\s*do it|confirm execution)$/i.test(t)) return true;
  if (/确认(本次|以上|这笔|swap|lp|交易|执行)/i.test(t)) return true;
  return false;
}

export function latchUserConfirm(current: boolean, statement: string): boolean {
  if (isUserCancel(statement)) return false;
  if (isUserConfirm(statement)) return true;
  return current;
}
