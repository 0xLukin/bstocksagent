import type { RemoteIntent } from "./runtime";

const NAMES: Record<string, string> = {
  NVDAB: "英伟达",
  TSLAB: "特斯拉",
  CRCLB: "Circle",
  MUB: "美光",
  SNDKB: "闪迪",
  SPCXB: "SpaceX",
  AMDB: "AMD",
  EWYB: "韩国 ETF",
  INTCB: "英特尔",
  MSTRB: "MicroStrategy",
  LITEB: "Lumentum",
  METAB: "Meta",
  MSFTB: "微软",
  PLTRB: "Palantir",
  QQQB: "纳斯达克 100",
  USDT: "USDT",
  USDC: "USDC",
  WBNB: "WBNB",
};

export type TicketKind = "swap" | "lp-mint" | "lp-increase" | "lp-decrease" | "lp-collect" | "other";

export type IntentView = {
  kind: TicketKind;
  eyebrow: string;
  title: string;
  cta: string;
  payLabel: string;
  getLabel: string;
  payAmount: string;
  paySymbol: string;
  payName?: string;
  getAmount: string;
  getSymbol: string;
  getName?: string;
  minGet?: string;
  slippage?: string;
  detail?: string;
  footnote: string;
  twoStep: boolean;
  stepLabel?: string;
  doneTitle: string;
  doneBody: string;
};

export function tokenName(symbol: string): string | undefined {
  return NAMES[symbol.toUpperCase()];
}

export function shortAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatUi(value: string, maxFrac = 6): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac, minimumFractionDigits: 0 });
}

export function remainingLabel(iso: string): { expired: boolean; text: string } {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return { expired: true, text: "已过期。回聊天再说「确认」，会重新出这一页。" };
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  return { expired: false, text: mins < 60 ? `还剩约 ${mins} 分钟可签` : `还剩约 ${Math.floor(mins / 60)} 小时可签` };
}

export function txTitle(label: string): string {
  if (/approve/i.test(label)) return "授权额度";
  if (/wrap/i.test(label)) return "把 BNB 包装成 WBNB";
  if (/unwrap/i.test(label)) return "把 WBNB 解包成 BNB";
  if (/swap/i.test(label)) return "兑换";
  if (/increase/i.test(label)) return "加进现有仓位";
  if (/decrease|withdraw/i.test(label)) return "退出仓位";
  if (/mint/i.test(label)) return "组 LP";
  if (/collect/i.test(label)) return "领取手续费";
  return label;
}

type ParkedLp = {
  token?: string;
  quote?: string;
  amountTokenUi?: string;
  amountQuoteUi?: string;
  budgetQuoteUi?: string;
  committed?: boolean;
  fee?: number;
};

function parkedLpOf(intent: RemoteIntent): ParkedLp | undefined {
  const raw = intent.summary.parkedLp;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ParkedLp;
}

/** True only when this swap is actually step 1 of minting LP, not a leftover park from another chat. */
export function wantsLpFollowUp(intent: RemoteIntent): boolean {
  if (intent.kind !== "swap") return false;
  const lp = parkedLpOf(intent);
  if (!lp?.token) return false;
  const tin = String(intent.summary.tokenIn ?? "").toUpperCase();
  const tout = String(intent.summary.tokenOut ?? "").toUpperCase();
  const quote = (lp.quote ?? "USDT").toUpperCase();
  const fundingQuote = tout === quote || tout === "USDT" || tout === "USDC" || tout === "WBNB" || tout === "BNB";
  if ((tin === "BNB" || tin === "WBNB") && fundingQuote && tout !== String(lp.token).toUpperCase()) {
    return true;
  }
  if (tout !== String(lp.token).toUpperCase()) return false;
  return Boolean(lp.committed || lp.amountTokenUi || lp.amountQuoteUi || lp.budgetQuoteUi || lp.fee == null);
}

function str(summary: Record<string, unknown>, key: string): string | undefined {
  const v = summary[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function minGetUi(summary: Record<string, unknown>): string | undefined {
  const outUi = str(summary, "amountOutUi");
  const bps = Number(summary.slippageBps);
  if (!outUi || !Number.isFinite(bps)) return undefined;
  return formatUi(String(Number(outUi) * (1 - bps / 10_000)));
}

function spoken(symbol: string): string {
  const name = tokenName(symbol);
  return name && name !== symbol ? `${symbol}（${name}）` : symbol;
}

export function buildIntentView(intent: RemoteIntent): IntentView {
  const s = intent.summary;
  const tokenIn = str(s, "tokenIn");
  const tokenOut = str(s, "tokenOut");
  const amountIn = str(s, "amountInUi");
  const amountOut = str(s, "amountOutUi");
  const analysis = s.analysis as { token0?: string; token1?: string } | undefined;
  const twoStep = wantsLpFollowUp(intent);

  if (intent.kind === "swap" && tokenIn && tokenOut && amountIn && amountOut) {
    const slip = Number(s.slippageBps);
    const buying = !/^(USDT|USDC|BNB|WBNB)$/i.test(tokenOut);
    const eyebrow = twoStep ? "第 1 步，共 2 步 · 先兑换" : buying ? "买入证书" : "卖出证书";
    const title = buying ? `用 ${spoken(tokenIn)} 买 ${spoken(tokenOut)}` : `把 ${spoken(tokenIn)} 换成 ${spoken(tokenOut)}`;
    return {
      kind: "swap",
      eyebrow,
      title,
      cta: buying ? "签名买入" : "签名卖出",
      payLabel: "从钱包支付",
      getLabel: "预计到账",
      payAmount: formatUi(amountIn, 4),
      paySymbol: tokenIn,
      payName: tokenIn === "BNB" ? "原生 BNB，不是 WBNB" : tokenName(tokenIn),
      getAmount: formatUi(amountOut),
      getSymbol: tokenOut,
      getName: tokenName(tokenOut),
      minGet: minGetUi(s),
      slippage: Number.isFinite(slip) ? `${(slip / 100).toFixed(2)}%` : undefined,
      footnote: twoStep
        ? "现在只签兑换。组 LP 会在这笔上链之后另开一页。"
        : "证书不是股票，没有投票权。成交以链上为准。不是投资建议。",
      twoStep,
      stepLabel: twoStep ? "签完后才会出现组 LP 页。现在这一页只兑换。" : undefined,
      doneTitle: "兑换已上链",
      doneBody: twoStep
        ? "正在根据到账余额准备组 LP 签名页。好了之后下面会出现按钮。"
        : "这笔兑换已经完成。可以关掉页面，或回聊天继续。",
    };
  }

  if (intent.kind === "lp-mint" || intent.kind === "lp-increase") {
    const t0 = str(s, "token0") ?? analysis?.token0 ?? "token0";
    const t1 = str(s, "token1") ?? analysis?.token1 ?? "token1";
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    const range = str(s, "rangePrices") ?? str(s, "rangeLabel");
    const fee = Number(s.fee);
    const increase = intent.kind === "lp-increase";
    const tokenId = str(s, "tokenId");
    return {
      kind: increase ? "lp-increase" : "lp-mint",
      eyebrow: increase ? "加进现有仓位，不开新 NFT" : "组 Pancake V3 LP",
      title: increase ? `加仓 NFT #${tokenId ?? ""}` : `组 ${spoken(t0)} / ${spoken(t1)} 仓位`,
      cta: increase ? "签名加仓" : "签名组 LP",
      payLabel: increase ? "再打进仓位" : "放入池子",
      getLabel: increase ? "加到" : "你将得到",
      payAmount: a0 && a1 ? `${formatUi(a0, 4)} + ${formatUi(a1, 4)}` : "双边",
      paySymbol: `${t0} + ${t1}`,
      payName: [tokenName(t0), tokenName(t1)].filter(Boolean).join(" / ") || undefined,
      getAmount: str(s, "rangeLabel") ?? "V3 仓位",
      getSymbol: increase ? `NFT #${tokenId ?? ""}` : "仓位 NFT",
      detail: [range, Number.isFinite(fee) ? `池手续费 ${(fee / 10000).toFixed(2)}%` : undefined]
        .filter(Boolean)
        .join(" · "),
      footnote: "有无常损失。价格走出区间后不再赚手续费。两边数量按区间公式，不是 50/50。",
      twoStep: false,
      doneTitle: increase ? "加仓已上链" : "仓位已打开",
      doneBody: increase
        ? "流动性已加进原来的 NFT。可以关掉页面。"
        : "仓位 NFT 会记在绑定钱包里。回聊天可以说「我的仓位」。",
    };
  }

  if (intent.kind === "lp-decrease") {
    const t0 = str(s, "token0") ?? analysis?.token0 ?? "token0";
    const t1 = str(s, "token1") ?? analysis?.token1 ?? "token1";
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    const tokenId = str(s, "tokenId");
    const burn = Boolean(s.burn);
    return {
      kind: "lp-decrease",
      eyebrow: burn ? "退出全部流动性" : "部分撤出",
      title: burn ? `赎回 NFT #${tokenId ?? ""}` : `减仓 NFT #${tokenId ?? ""}`,
      cta: burn ? "签名赎回" : "签名减仓",
      payLabel: "退出仓位",
      getLabel: "回到钱包（约）",
      payAmount: tokenId ? `#${tokenId}` : "仓位",
      paySymbol: burn ? "NFT 将销毁" : "仓位保留",
      getAmount: a0 && a1 ? `${formatUi(a0, 4)} + ${formatUi(a1, 4)}` : "本金 + 手续费",
      getSymbol: `${t0} + ${t1}`,
      footnote: "按当下池价结算。未领手续费一并到账。实际数量以链上为准。",
      twoStep: false,
      doneTitle: "仓位已退出",
      doneBody: "代币已回到绑定钱包。若要卖掉尘埃，回聊天说「把赎回的卖掉」。",
    };
  }

  if (intent.kind === "lp-collect") {
    const t0 = str(s, "token0") ?? analysis?.token0;
    const t1 = str(s, "token1") ?? analysis?.token1;
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    const tokenId = str(s, "tokenId");
    return {
      kind: "lp-collect",
      eyebrow: "只领手续费",
      title: `领取 NFT #${tokenId ?? ""} 的手续费`,
      cta: "签名领手续费",
      payLabel: "仓位本金",
      getLabel: "领到钱包（约）",
      payAmount: "不动",
      paySymbol: "流动性留在池里",
      getAmount: a0 && a1 ? `${formatUi(a0, 6)} + ${formatUi(a1, 6)}` : "手续费",
      getSymbol: t0 && t1 ? `${t0} + ${t1}` : "池子代币",
      detail: tokenId ? `NFT #${tokenId}` : undefined,
      footnote: "本金还在仓位里。这不是赎回。",
      twoStep: false,
      doneTitle: "手续费已领取",
      doneBody: "本金仍在 NFT 里。可以关掉页面。",
    };
  }

  return {
    kind: "other",
    eyebrow: "钱包签名",
    title: "确认这笔交易",
    cta: "确认并签名",
    payLabel: "支付",
    getLabel: "获得",
    payAmount: amountIn ? formatUi(amountIn) : "—",
    paySymbol: tokenIn ?? "",
    getAmount: amountOut ? formatUi(amountOut) : "—",
    getSymbol: tokenOut ?? "",
    footnote: "在钱包弹窗里核对网络和数量。",
    twoStep: false,
    doneTitle: "已广播",
    doneBody: "可以关掉页面，或回聊天继续。",
  };
}
