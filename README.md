# bstocks-yield

BNB Chain 上的 **非托管** bStocks 交易 + PancakeSwap V3 LP Agent。面向 Termix 雇佣，但 **不会在本仓库里铸造 NFT 或发布线上 Listing**（需要你自己的 `WALLET_KEY` 与资金）。仓库提供可本地运行的 Runtime、签名页、CLI，以及上线脚本（默认 dry-run）。

## 两套资金流（不要混）

| 流 | 谁签名 | 用途 |
| --- | --- | --- |
| Termix 托管 | Agent 钱包（`WALLET_KEY`） | 接单、交交付物、超时 `claimAfterTimeout` |
| 用户 DeFi | 用户自己的钱包（签名页） | approve / swap / mint LP / collect |

签名页 **没有** Agent 私钥。合约调用 **只用 raw**；对话和报告用 ERC-8056 UI 股数。

## 要求

- Node 20+
- pnpm 10+
- 稳定的 BSC RPC（公共节点仅供本地）

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm typecheck
pnpm test
```

## 本地运行

两个进程：

```bash
# 终端 1 — Agent Runtime（意图存储 + 可选 A2A + 本地 /chat）
pnpm dev:runtime

# 终端 2 — 签名页 http://127.0.0.1:3000
pnpm dev:signer
```

本地对话（不经过 Termix）：

```bash
curl -s http://127.0.0.1:8787/chat \
  -H 'content-type: application/json' \
  -d '{"conversationId":"local","text":"我确认不在美国及受限地区"}'
```

### CLI（只读报价 / 生成 calldata，默认不广播）

```bash
pnpm quote -- --in USDT --out NVDAB --amount 10
pnpm swap-intent -- --in USDT --out NVDAB --amount 10 --user 0x你的地址
pnpm lp-intent -- --token NVDAB --amount 0.01 --user 0x你的地址
```

`swap-intent` / `lp-intent` 输出待签交易（有界 approve + `amountMin != 0` + 短 deadline + SmartRouter/NFPM multicall）。**不会**替你发主网交易。

## 环境变量

见 `.env.example`。密钥只放 `.env`，不要提交。

| 变量 | 用途 |
| --- | --- |
| `BSC_RPC_URL` | BSC JSON-RPC |
| `WALLET_KEY` | **仅** Termix 侧 Agent 钱包。本地 DeFi CLI / 签名页不需要 |
| `AACP_API` | 默认 `https://platform-backend.prod.termix.live` |
| `TERMIX_AGENT_ID` | 铸造成功后填入；未设置时 A2A 轮询空转 |
| `OPENROUTER_API_KEY` 或 `OPENAI_API_KEY` | 工具调用。未设置时 Runtime 走规则回复 |
| `SIGNER_WEB_URL` | 发给买家的签名页前缀 |
| `NEXT_PUBLIC_RUNTIME_URL` | 签名页回读意图 |

Termix 合约地址 **启动时** 从 `GET /api/v1/config/contracts` 拉取，代码里不写死。

## 合规（对话 / Listing / 交付物都会重复）

- 不构成投资建议
- 美国及受限地区禁止；未地理确认不出交易
- LP 有无常损失；非交易时段可能偏离正股
- bStocks 是证书，不是股票，无投票权
- 用户最终签名

## Termix 上线脚本（默认不花 gas）

全部 dry-run，除非你显式加 `--broadcast` / `--publish` 且配置了 `WALLET_KEY`。

```bash
pnpm termix:mint                 # 检查 handle bstocks-yield + 打印 prepare
pnpm termix:listing              # 打印 listing JSON（instantBuyable=false, deliveryDays=3, USDT）
pnpm termix:accept -- <orderId>
pnpm termix:deliver -- <orderId> ./path/report.md
pnpm termix:claim-watch          # 超时 claim 看门狗
```

Listing 类别：`Automation & Ops`。handle：`bstocks-yield`（铸造时只能设一次）。

### 没有自动结算

Termix **没有** auto-settle worker。订单 `DELIVERED` 且挑战窗口结束后，必须有人调用 `claimAfterTimeout`，否则佣金一直停在托管里。Runtime 内置看门狗；也可单独跑 `pnpm termix:claim-watch`。

## 仓库结构

- `apps/runtime` — A2A 轮询（≥5s）、LLM 工具、意图 HTTP、订单看门狗
- `apps/signer-web` — Next.js + wagmi + viem，路由 `/t/:intentId`，仅 BSC
- `packages/chain` — 白名单、ERC-8056、V3 quote/swap/LP
- `packages/termix` — AACP REST（session / runtime token / listing / order）
- `packages/risk` — 白名单、滑点、规模、流动性、偏离、地理门闩
- `packages/report` — 交付 Markdown/JSON
- `config/*.json` — 代币、池、风控（逻辑不写死地址）

## 代币与 Pancake 地址

`config/tokens.json` 中的 bStocks / USDT / USDC / WBNB 已在 2026-08-26 用 BSC `symbol()` 核对。Pancake 地址与官方文档一致（SmartRouter / NFPM / QuoterV2 / Factory），见 `config/pools.json` 注释。

未做主网真钱 swap。报价依赖公共 RPC，偶发超时属正常。
