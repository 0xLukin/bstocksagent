import {
  buildMintLpTxs,
  compareLpPools,
  DEFAULT_LP_RANGE_BPS,
  getToken,
  parseUiNumber,
  quoteSwap,
  readBalanceUi,
} from "@bstocks/chain";
import { type Address, type PublicClient } from "viem";

const GAS_BNB = 0.003;

export type LpProposalOption = {
  n: number;
  action: "mint" | "fund" | "blocked";
  title: string;
  token: string;
  quote: string;
  fee: number;
  feeLabel: string;
  apr24hPct: number;
  amountTokenUi?: string;
  amountQuoteUi?: string;
  budgetQuoteUi?: string;
  needTokenUi: string;
  needQuoteUi: string;
  funding?: { tokenIn: string; tokenOut: string; amountInUi: string; amountOutUi: string };
  note: string;
};

export type LpProposal = {
  kind: "lp-propose";
  token: string;
  balances: { token: string; usdt: string; bnb: string };
  options: LpProposalOption[];
  selected?: number;
};

function trimAmt(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toPrecision(4);
}

async function mintPreview(
  client: PublicClient,
  wallet: Address,
  args: { token: string; quote: string; fee: number; amountTokenUi?: string; amountQuoteUi?: string },
) {
  return buildMintLpTxs({
    userAddress: wallet,
    token: args.token,
    quote: args.quote,
    fee: args.fee,
    amountTokenUi: args.amountTokenUi,
    amountQuoteUi: args.amountQuoteUi,
    rangeBps: DEFAULT_LP_RANGE_BPS,
    slippageBps: 50,
    deadlineSeconds: 180,
    client,
  });
}

function needFor(preview: Awaited<ReturnType<typeof mintPreview>>, token: string, quote: string) {
  const s = preview.summary;
  const t0 = String(s.token0);
  const t1 = String(s.token1);
  const a0 = String(s.amount0Ui ?? "0");
  const a1 = String(s.amount1Ui ?? "0");
  const q = quote === "BNB" ? "WBNB" : quote;
  const needToken = t0 === token ? a0 : t1 === token ? a1 : "0";
  const needQuote = t0 === q ? a0 : t1 === q ? a1 : "0";
  return { needToken, needQuote };
}

export async function buildLpProposal(args: {
  token: string;
  wallet: Address;
  client: PublicClient;
}): Promise<LpProposal> {
  const token = getToken(args.token).symbol;
  const compared = await compareLpPools(token);
  const tokenBal = await readBalanceUi(args.client, getToken(token), args.wallet);
  const usdtBal = await readBalanceUi(args.client, getToken("USDT"), args.wallet);
  const bnbWei = await args.client.getBalance({ address: args.wallet });
  const bnbUi = trimAmt((Number(bnbWei) / 1e18).toString());
  const tokenUi = tokenBal.uiDisplay;
  const usdtUi = usdtBal.uiDisplay;
  const tokenN = parseUiNumber(tokenUi);
  const usdtN = parseUiNumber(usdtUi);
  const bnbN = Number(bnbWei) / 1e18;

  const options: LpProposalOption[] = [];
  const pools = (compared.ranked.length ? compared.ranked : compared.pools.filter((p) => !p.thin)).slice(0, 3);

  for (const pool of pools) {
    const quote = pool.quote === "BNB" ? "WBNB" : pool.quote;
    const quoteIsUsdt = quote === "USDT" || quote === "USDC";
    if (!quoteIsUsdt) continue;

    if (tokenN <= 0) {
      options.push({
        n: options.length + 1,
        action: "blocked",
        title: `${token}/${quote} ${pool.feeLabel}`,
        token,
        quote,
        fee: pool.fee,
        feeLabel: pool.feeLabel,
        apr24hPct: pool.apr24hPct,
        needTokenUi: "0",
        needQuoteUi: "0",
        note: `钱包里没有 ${token}，没法组这个池。`,
      });
      continue;
    }

    try {
      const fit = await mintPreview(args.client, args.wallet, {
        token,
        quote,
        fee: pool.fee,
        amountTokenUi: tokenUi,
        ...(usdtN > 0 ? { amountQuoteUi: usdtUi } : {}),
      });
      const need = needFor(fit, token, quote);
      const needQuoteN = parseUiNumber(need.needQuote);
      const haveQuoteN = quoteIsUsdt ? usdtN : 0;
      const canFit = quoteIsUsdt ? haveQuoteN + 1e-12 >= needQuoteN && needQuoteN > 0 : false;

      if (canFit && parseUiNumber(need.needToken) > 0) {
        options.push({
          n: options.length + 1,
          action: "mint",
          title: `${token}/${quote} ${pool.feeLabel} · 用现有余额`,
          token,
          quote,
          fee: pool.fee,
          feeLabel: pool.feeLabel,
          apr24hPct: pool.apr24hPct,
          amountTokenUi: need.needToken,
          amountQuoteUi: need.needQuote,
          needTokenUi: need.needToken,
          needQuoteUi: need.needQuote,
          note: `现在就能组：约 ${trimAmt(need.needToken)} ${token} + ${trimAmt(need.needQuote)} ${quote}。出区间没有手续费。`,
        });
      }

      if (quoteIsUsdt && tokenN > 0) {
        const full = await mintPreview(args.client, args.wallet, {
          token,
          quote,
          fee: pool.fee,
          amountTokenUi: tokenUi,
        });
        const fullNeed = needFor(full, token, quote);
        const short = parseUiNumber(fullNeed.needQuote) - usdtN;
        if (short > 0.05) {
          const px = await quoteSwap({
            tokenIn: "BNB",
            tokenOut: quote,
            amountInUi: "0.01",
            client: args.client,
          });
          const usdtPerBnb = parseUiNumber(px.amountOutUi) / 0.01;
          const bnbNeed = usdtPerBnb > 0 ? (short * 1.08) / usdtPerBnb : 0;
          const bnbLeft = bnbN - bnbNeed;
          if (bnbNeed > 0 && bnbLeft >= GAS_BNB) {
            const funded = await quoteSwap({
              tokenIn: "BNB",
              tokenOut: quote,
              amountInUi: bnbNeed.toFixed(6),
              client: args.client,
            });
            options.push({
              n: options.length + 1,
              action: "fund",
              title: `${token}/${quote} ${pool.feeLabel} · 先用 BNB 补 ${quote}`,
              token,
              quote,
              fee: pool.fee,
              feeLabel: pool.feeLabel,
              apr24hPct: pool.apr24hPct,
              amountTokenUi: fullNeed.needToken,
              amountQuoteUi: fullNeed.needQuote,
              budgetQuoteUi: (usdtN + parseUiNumber(funded.amountOutUi)).toFixed(4),
              needTokenUi: fullNeed.needToken,
              needQuoteUi: fullNeed.needQuote,
              funding: {
                tokenIn: "BNB",
                tokenOut: quote,
                amountInUi: funded.amountInUi,
                amountOutUi: funded.amountOutUi,
              },
              note: `${quote} 还差约 ${trimAmt(String(short))}。用 ${trimAmt(funded.amountInUi)} BNB 换成约 ${trimAmt(funded.amountOutUi)} ${quote}，再组 LP。两步都要你自己签名。`,
            });
          } else {
            options.push({
              n: options.length + 1,
              action: "blocked",
              title: `${token}/${quote} ${pool.feeLabel} · 全仓 ${token}`,
              token,
              quote,
              fee: pool.fee,
              feeLabel: pool.feeLabel,
              apr24hPct: pool.apr24hPct,
              needTokenUi: fullNeed.needToken,
              needQuoteUi: fullNeed.needQuote,
              note: `全仓需要约 ${trimAmt(fullNeed.needQuote)} ${quote}，你只有 ${trimAmt(usdtUi)}；BNB 也不够既补缺口又留 gas。`,
            });
          }
        }
      }
    } catch (err) {
      options.push({
        n: options.length + 1,
        action: "blocked",
        title: `${token}/${quote} ${pool.feeLabel}`,
        token,
        quote,
        fee: pool.fee,
        feeLabel: pool.feeLabel,
        apr24hPct: pool.apr24hPct,
        needTokenUi: "?",
        needQuoteUi: "?",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const seen = new Set<string>();
  const deduped: LpProposalOption[] = [];
  for (const o of options) {
    const key = `${o.action}:${o.quote}:${o.fee}:${o.funding?.amountInUi ?? o.amountQuoteUi ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...o, n: deduped.length + 1 });
  }

  if (!deduped.length) {
    deduped.push({
      n: 1,
      action: "blocked",
      title: `${token}/USDT`,
      token,
      quote: "USDT",
      fee: 10000,
      feeLabel: "1%",
      apr24hPct: 0,
      needTokenUi: tokenUi,
      needQuoteUi: usdtUi,
      note: `按当前余额没法组可交易的 USDT/USDC 池。余额：${token} ${tokenUi} · USDT ${usdtUi} · BNB ${bnbUi}。可以说要换多少、或补哪种资产。`,
    });
  }

  return {
    kind: "lp-propose",
    token,
    balances: { token: tokenUi, usdt: usdtUi, bnb: bnbUi },
    options: deduped.slice(0, 4),
  };
}

const PICK_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, a: 1, b: 2, c: 3, d: 4 };

function pickDigit(raw: string): number | null {
  const key = raw.toLowerCase();
  if (PICK_NUM[key] != null) return PICK_NUM[key]!;
  const n = Number(raw);
  return n >= 1 && n <= 4 ? n : null;
}

export function parseLpPick(text: string): number | null {
  const t = text.trim();
  const exact = t.match(/^(?:方案\s*)?([1-4]|[一二三四]|[A-Da-d])[。.!！]?$/i);
  if (exact) return pickDigit(exact[1]!);
  const wrapped = t.match(
    /^(?:确认|选|选择|要|就选)?\s*方案\s*([1-4]|[一二三四])(?:号)?[。.!！]?$/i,
  );
  if (wrapped) return pickDigit(wrapped[1]!);
  const confirmN = t.match(/^(?:确认|选|选择)\s*([1-4])(?:号|号方案)?[。.!！]?$/i);
  if (confirmN) return pickDigit(confirmN[1]!);
  if (/^(第一个|方案一)$/i.test(t)) return 1;
  if (/^(第二个|方案二)$/i.test(t)) return 2;
  if (/^(第三个|方案三)$/i.test(t)) return 3;
  if (/^(第四个|方案四)$/i.test(t)) return 4;
  return null;
}

/** 「确认方案1」= pick + execute. Bare 「1」/「方案1」= pick only. */
export function lpPickWantsExecute(text: string): boolean {
  const t = text.trim();
  if (/^(?:方案\s*)?(?:[1-4]|[一二三四]|[A-Da-d]|第一个|第二个|第三个|第四个)[。.!！]?$/i.test(t)) return false;
  return /确认|执行|就这个|马上|直接签/.test(t);
}

export function pendingLpFromOption(opt: LpProposalOption): {
  token: string;
  quote: string;
  fee: number;
  amountTokenUi?: string;
  amountQuoteUi?: string;
  budgetQuoteUi?: string;
  rangeBps: number;
  committed: true;
} {
  return {
    token: opt.token,
    quote: opt.quote,
    fee: opt.fee,
    amountTokenUi: opt.amountTokenUi,
    amountQuoteUi: opt.amountQuoteUi,
    budgetQuoteUi: opt.budgetQuoteUi,
    rangeBps: DEFAULT_LP_RANGE_BPS,
    committed: true,
  };
}

export function fundOptionForSwap(
  prop: LpProposal | undefined,
  swap?: { tokenIn: string; tokenOut: string; amountInUi: string },
): LpProposalOption | undefined {
  if (!prop?.options?.length || !swap) return undefined;
  const selected = prop.selected != null ? prop.options.find((o) => o.n === prop.selected) : undefined;
  if (selected?.action === "fund" && selected.funding) return selected;
  const inn = swap.tokenIn.toUpperCase();
  const amt = Number(swap.amountInUi);
  return prop.options.find((o) => {
    if (o.action !== "fund" || !o.funding) return false;
    const src = o.funding.tokenIn.toUpperCase();
    const sameIn =
      src === inn ||
      ((src === "BNB" || src === "WBNB") && (inn === "BNB" || inn === "WBNB"));
    if (!sameIn) return false;
    return Number.isFinite(amt) && Math.abs(Number(o.funding.amountInUi) - amt) < 1e-5;
  });
}