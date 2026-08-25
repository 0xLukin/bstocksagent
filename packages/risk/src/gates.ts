import { loadRiskConfig } from "./load.js";
import type { RiskConfig, RiskContext, RiskVerdict } from "./types.js";

const COMPLIANCE_ZH = {
  geo: "未确认非美国/受限地区居住，拒绝出交易。bStocks 不对美国及受限地区用户提供。",
  confirm: "用户尚未明确确认本次操作，不会创建待签意图。",
  whitelist: "标的不在白名单内，拒绝报价与交易。",
  slippage: "滑点超过风控上限。",
  size: "单笔名义本金超过上限。",
  liquidity: "池子流动性低于最小门槛。",
  deviation: "池价相对参考价偏离过大。",
  amountMin: "amountMin 不能为 0。",
};

export function evaluateRisk(ctx: RiskContext, config: RiskConfig = loadRiskConfig()): RiskVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (config.requireGeoConfirm && !ctx.geoConfirmed) {
    blockers.push(COMPLIANCE_ZH.geo);
  }
  if (ctx.geo && config.restrictedGeos.map((g) => g.toUpperCase()).includes(ctx.geo.toUpperCase())) {
    blockers.push(`受限地区 ${ctx.geo}：${COMPLIANCE_ZH.geo}`);
  }
  if (config.requireUserConfirmBeforeIntent && !ctx.userConfirmed) {
    blockers.push(COMPLIANCE_ZH.confirm);
  }
  if (!ctx.whitelistOk) {
    blockers.push(COMPLIANCE_ZH.whitelist);
  }
  if (ctx.slippageBps > config.maxSlippageBps) {
    blockers.push(`${COMPLIANCE_ZH.slippage}（${ctx.slippageBps} bps > ${config.maxSlippageBps} bps）`);
  }
  if (ctx.notionalUsd > config.maxNotionalUsd) {
    blockers.push(`${COMPLIANCE_ZH.size}（$${ctx.notionalUsd} > $${config.maxNotionalUsd}）`);
  }
  if (ctx.poolLiquidityUsd > 0 && ctx.poolLiquidityUsd < config.minPoolLiquidityUsd) {
    blockers.push(`${COMPLIANCE_ZH.liquidity}（$${ctx.poolLiquidityUsd} < $${config.minPoolLiquidityUsd}）`);
  }
  if (ctx.priceDeviationBps > config.maxPriceDeviationBps) {
    blockers.push(`${COMPLIANCE_ZH.deviation}（${ctx.priceDeviationBps} bps > ${config.maxPriceDeviationBps} bps）`);
  }
  if (config.rejectZeroAmountMin && ctx.amountMin <= 0n) {
    blockers.push(COMPLIANCE_ZH.amountMin);
  }
  if (ctx.slippageBps > config.defaultSlippageBps) {
    warnings.push(`滑点 ${ctx.slippageBps} bps 高于默认 ${config.defaultSlippageBps} bps。`);
  }
  warnings.push("本服务不构成投资建议。用户自行签名并承担链上风险。");
  warnings.push("LP 可能发生无常损失；证书类敞口不等于直接持股。");

  return { ok: blockers.length === 0, blockers, warnings };
}

export function latchGeoConfirm(current: boolean, statement: string): boolean {
  const t = statement.toLowerCase();
  const denied = /美国|united states|\bus\b|restricted|受限/.test(t) && /是|yes|live|居住/.test(t);
  if (denied && !/不在|不是|not|no/.test(t)) return false;
  const affirmed =
    /不在美国|非美国|不是美国人|not in the (us|usa|united states)|i am not (in )?(the )?(us|usa)/i.test(
      statement,
    ) || /确认.*非.*受限/.test(statement);
  return current || affirmed;
}

export function latchUserConfirm(current: boolean, statement: string): boolean {
  const t = statement.trim();
  if (/^(确认|同意|确认执行|confirm|yes,?\s*do it|proceed)$/i.test(t)) return true;
  if (/确认(本次|以上|这笔|swap|lp|交易)/i.test(t)) return true;
  return current;
}
