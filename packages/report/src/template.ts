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
      "This report and the conversation are not investment advice, solicitation, or a recommendation.",
      "bStocks are certificate-style exposure, not direct equity, and holders have no voting rights.",
      "Users in the United States and restricted regions may not use this service.",
      "PancakeSwap V3 LP can incur impermanent loss. Off-hours prices may deviate from the underlying.",
      "On-chain raw amounts can differ from UI shares because of ERC-8056 uiMultiplier (splits / dividend reinvestment). Contracts always use raw.",
      "All DeFi trades are signed and broadcast by the user's wallet. The agent wallet only handles Termix escrow fees.",
      "Termix has no auto-settle worker. After delivery, if the buyer does not accept, call claimAfterTimeout after the challenge window.",
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

Generated: ${report.generatedAt}

- User: \`${report.userAddress ?? "—"}\`
- Order: \`${report.orderId ?? "—"}\`

## Transaction hashes

${txs || "- (none)"}

## Position snapshot

\`\`\`json
${JSON.stringify(report.positions, null, 2)}
\`\`\`

## Signer intent log

\`\`\`json
${JSON.stringify(report.intents, null, 2)}
\`\`\`

## Notes

${notes || "- (none)"}

## Risk disclosure

${risks}
`;
}
