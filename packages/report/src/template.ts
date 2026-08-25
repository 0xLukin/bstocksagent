export type DeliveryReport = {
  title: string;
  generatedAt: string;
  userAddress?: string;
  orderId?: string;
  txs: Array<{
    kind: string;
    hash: string;
    note?: string;
  }>;
  positions?: unknown[];
  intents?: unknown[];
  riskDisclaimer: string[];
  notes: string[];
};

export function buildDeliveryReport(input: Omit<DeliveryReport, "generatedAt" | "riskDisclaimer"> & {
  generatedAt?: string;
}): DeliveryReport {
  return {
    title: input.title,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    userAddress: input.userAddress,
    orderId: input.orderId,
    txs: input.txs,
    positions: input.positions ?? [],
    intents: input.intents ?? [],
    notes: input.notes,
    riskDisclaimer: [
      "本报告及对话内容不构成投资建议、招揽或推荐。",
      "bStocks 是证书类敞口，不是直接持股，持有人无投票权。",
      "美国及受限地区用户不得使用本服务。",
      "PancakeSwap V3 LP 存在无常损失；非交易时段价格可能相对正股偏离。",
      "链上 raw 数量与 UI 股数可能因 ERC-8056 uiMultiplier（拆股/分红复投）不一致。合约一律使用 raw。",
      "所有 DeFi 交易由用户自己的钱包签名广播；Agent 钱包只处理 Termix 托管佣金。",
      "Termix 没有自动结算 worker。交付后若买家不 accept，需在挑战窗口结束后调用 claimAfterTimeout。",
    ],
  };
}

export function renderMarkdown(report: DeliveryReport): string {
  const txs = report.txs
    .map((t) => `- \`${t.hash}\` (${t.kind})${t.note ? ` — ${t.note}` : ""}`)
    .join("\n");
  const risks = report.riskDisclaimer.map((r) => `- ${r}`).join("\n");
  const notes = report.notes.map((n) => `- ${n}`).join("\n");
  return `# ${report.title}

生成时间：${report.generatedAt}

- 用户地址：\`${report.userAddress ?? "—"}\`
- 订单：\`${report.orderId ?? "—"}\`

## 交易哈希

${txs || "- （无）"}

## 仓位快照

\`\`\`json
${JSON.stringify(report.positions, null, 2)}
\`\`\`

## 签名页意图记录

\`\`\`json
${JSON.stringify(report.intents, null, 2)}
\`\`\`

## 说明

${notes || "- （无）"}

## 风险声明

${risks}
`;
}
