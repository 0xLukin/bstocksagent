# bstocks-yield-agent

BNB Chain 上的非托管 Agent：用口语买卖白名单 [bStocks](https://bstocks.com/)，并在 PancakeSwap **仅 V3** 加、管流动性。跑在 [Termix](https://docs.termix.ai/) 上，买家自己的钱包签名，Agent 碰不到私钥。

对话用简体中文。链上 symbol 是 `NVDAB` / `MSFTB` 这种「代码 + B」；说「英伟达」「NVDA」「微软」会映射到同一条白名单记录。

> 不是投资顾问，不承诺收益或年化。bStocks 是证书类敞口，不是正股，无投票权。美国及受限地区不可用。

## 能做什么

- **查价 / 兑换**：`用 100 USDT 买英伟达`、`用 0.05 BNB 买 NVDAB`、`卖 0.5 英伟达`。原生 BNB 和 WBNB 分开，不会互相顶替。
- **对比 LP 年化**：`英伟达最高 apr`。走 Pancake Explorer 的 BSC V3 池，只列对端为 USDT / USDC / WBNB 的白名单池，并标出薄池。数字是近 24h **手续费年化**，不是你的仓位收益，也不是承诺。
- **加池**：默认 `NVDAB / USDT 0.25%`、区间 ±30%。也可以指定档位：`加 100u 那个最高的`、`加 100u 英伟达 WBNB 0.25%`。确认后按同一组 quote + fee 出意图，不会改回默认池。
- **管仓位**：`我的仓位`、`收手续费`、`撤一半`、`全撤`。先列 NFT，再等确认。
- **取消**：`取消` / `不要了` 只取消未广播的报价和签名页，不会取消 Termix 雇佣单，也撤不掉已经上链的成交。

默认滑点 50 bps（上限 80 bps）。单笔名义规模、池流动性、价格偏离见 `config/risk.json`。

## 买家怎么走

1. 声明不在美国及受限地区。
2. 给出 BSC 钱包（`0x…`），或由 Termix inbox 带上。
3. 用一句话说标的和金额（或先问哪个池年化高）。
4. 核对报价 / 池档 / 风险后回复 **确认执行**。
5. 打开签名页，用**绑定的那只钱包**核对地址、数量、raw 后再签。

签名页会先 `eth_call` 模拟并估算 gas；硬失败不能确认。授权是有界 approve，`amountMin` 不得为 0，deadline 很短。

本地不经过 Termix 也可以走完同一条路径：

```bash
pnpm dev:runtime    # :8787  意图 + /chat
pnpm dev:signer     # :3000  签名页
pnpm chat           # 终端里对话，conversation=local
```

例句：`我确认不在美国及受限地区` → 粘贴 `0x` → `英伟达最高 apr` → `加 100刀到最好的那个池子` → `确认执行`。

没配 `DEEPSEEK_API_KEY` 时，规则例句（报价 / 加池 / 仓位 / 确认）仍然可用。配了 key 之后走 DeepSeek 工具调用，默认 `deepseek-v4-flash`。

## 两套钱，不要混

| | 谁签名 | 干什么 |
| --- | --- | --- |
| Termix 托管 | Agent 钱包 `WALLET_KEY` | 接单、交交付物、超时 `claimAfterTimeout` |
| 用户 DeFi | 用户自己的钱包（签名页） | approve / swap / mint / collect / decrease |

Agent **没有**用户私钥，也不替用户发主网交易。合约调用只用 ERC-8056 **raw**；对话和报告用 UI 股数。

收款只走 Termix 托管。不接 BNB Agent Studio，不接 x402。只做 BSC（chainId 56）和 Pancake V3，不做 V2 / Venus / Lista。

## 白名单

代币和池在 `config/tokens.json`、`config/pools.json`，不在代码里写死地址。2026-08-26 用链上 `symbol()` 核对过。

bStocks：NVDAB、TSLAB、CRCLB、MUB、SNDKB、SPCXB、AMDB、EWYB、INTCB、MSTRB、LITEB、METAB、MSFTB、PLTRB、QQQB。  
报价资产：USDT、USDC、WBNB（口语里的 BNB 是原生 gas）。

报价会在 `preferredFee` + `feeTiers` 里比 `amountOut`，必要时两跳走 `USDT → USDC → WBNB`。未写进 `pools.json` 的 V3 池（例如 NVDAB/WBNB）运行时用 Factory `getPool` 解析。

## 风险（对话、Listing、交付物都会重复）

- 不构成投资建议，不承诺年化。
- 美国及受限地区禁止；未地理确认不出交易意图。
- LP 有无常损失；区间越窄越容易脱区间、不再吃手续费。
- 非美股交易时段，链上价格可能相对正股偏离。
- 薄池的 APR 数字仅供参考，不能当「最高」去 mint。
- 用户最终自己签名、自己承担结果。

## 本地开发

需要 Node 20+、pnpm 10+、稳定的 BSC RPC（公共节点只适合本地）。

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm typecheck
pnpm test
```

只读报价 / 生成 calldata（默认不广播）：

```bash
pnpm quote -- --in USDT --out NVDAB --amount 10
pnpm swap-intent -- --in USDT --out NVDAB --amount 10 --user 0x你的地址
pnpm lp-intent -- --token NVDAB --amount 0.01 --user 0x你的地址
```

生产签名页：https://signer-web-phi.vercel.app  
Runtime 发给买家的链接前缀是 `SIGNER_WEB_URL`。意图数据仍由 Runtime 提供；HTTPS 签名页回不了 `http://127.0.0.1`，所以生产要把 `NEXT_PUBLIC_RUNTIME_URL` 指到公网 Runtime。

### 对话记忆

Termix inbox **每次只推买家的新一句**，没有会话回放。Runtime 按 `conversationId` 自己记：

1. 记忆卡：地理声明、钱包、待执行报价 / 加池档位、最近签名页、`orderId`
2. 最近 24 轮 transcript
3. inbox 游标 + `messageId` 幂等；同一 `orderId` 的新线程会继承钱包和地理声明

数据在仓库根目录 `.data/`（不要用 `apps/runtime/.data`）。本地 `/chat` 默认 `conversationId=local`。

### 环境变量

完整列表见 `.env.example`。密钥只放 `.env`，不要提交。

| 变量 | 用途 |
| --- | --- |
| `BSC_RPC_URL` | BSC JSON-RPC |
| `WALLET_KEY` | **仅** Termix 侧 Agent 钱包。本地报价 / 签名页不需要 |
| `DEEPSEEK_API_KEY` | 自然语言工具调用 |
| `A2A_LLM_MODEL` | 默认 `deepseek-v4-flash` |
| `TERMIX_AGENT_ID` | 铸造成功后填入；未设置时 A2A 轮询空转 |
| `SIGNER_WEB_URL` | 发给买家的签名页前缀 |
| `NEXT_PUBLIC_RUNTIME_URL` | 签名页回读意图 |

Termix 合约地址启动时从 `GET /api/v1/config/contracts` 拉取，代码里不写死。

## Termix 上线

仓库不会自动铸造 NFT 或发布 Listing。脚本默认 dry-run，显式 `--broadcast` / `--publish` 且配置了 `WALLET_KEY` 才会上链。

```bash
pnpm termix:mint                 # handle: bstocks-yield（只能设一次）
pnpm termix:listing              # instantBuyable=false, deliveryDays=3, USDT
pnpm termix:accept -- <orderId>
pnpm termix:deliver -- <orderId> ./path/report.md
pnpm termix:claim-watch
```

Listing 类别：Automation & Ops。Termix 铸的 NFT 就是 BSC 官方 Identity Registry 上的身份。

Termix **没有**自动结算。订单 `DELIVERED` 且挑战窗口结束后，要有人调用 `claimAfterTimeout`，否则佣金一直停在托管里。Runtime 内置看门狗，也可单独跑 `pnpm termix:claim-watch`。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `apps/runtime` | A2A 轮询、LLM 工具、意图 HTTP、订单看门狗、本地 `/chat` |
| `apps/signer-web` | Next.js + wagmi，`/t/:intentId`，仅 BSC；模拟 + 估 gas |
| `packages/chain` | 白名单、ERC-8056、V3 报价 / 兑换 / LP、Explorer 年化对比 |
| `packages/termix` | AACP REST |
| `packages/risk` | 白名单、滑点、规模、流动性、偏离、地理门闩 |
| `packages/report` | 交付 Markdown / JSON |
| `config/*.json` | 代币、池、风控 |

未做主网替用户代发成交。报价依赖公共 RPC，偶发超时属正常。
