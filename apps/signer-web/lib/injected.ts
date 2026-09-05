import { createConnector } from "wagmi";
import { getAddress, numberToHex, type Address } from "viem";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isOkxWallet?: boolean;
  isOKExWallet?: boolean;
  providers?: EthereumProvider[];
};

type Announced = { rdns?: string; name?: string; provider: EthereumProvider };

const announced: Announced[] = [];
let listening = false;

function win(): Window & {
  ethereum?: EthereumProvider;
  okxwallet?: EthereumProvider;
} {
  return window as Window & { ethereum?: EthereumProvider; okxwallet?: EthereumProvider };
}

function isOkx(item: Announced | EthereumProvider | undefined): boolean {
  if (!item) return false;
  if ("provider" in (item as Announced) && (item as Announced).provider) {
    const a = item as Announced;
    const id = `${a.rdns ?? ""} ${a.name ?? ""}`.toLowerCase();
    if (id.includes("okx") || id.includes("okex")) return true;
    return isOkx(a.provider);
  }
  const p = item as EthereumProvider;
  return Boolean(p.isOkxWallet || p.isOKExWallet);
}

function listenEip6963() {
  if (typeof window === "undefined" || listening) return;
  listening = true;
  window.addEventListener("eip6963:announceProvider", ((event: Event) => {
    const detail = (event as CustomEvent<{ info?: { rdns?: string; name?: string }; provider?: EthereumProvider }>).detail;
    if (!detail?.provider) return;
    if (announced.some((row) => row.provider === detail.provider)) return;
    announced.push({ rdns: detail.info?.rdns, name: detail.info?.name, provider: detail.provider });
  }) as EventListener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function candidates(): EthereumProvider[] {
  if (typeof window === "undefined") return [];
  listenEip6963();
  const w = win();
  const out: EthereumProvider[] = [];
  const push = (p?: EthereumProvider) => {
    if (p && !out.includes(p)) out.push(p);
  };
  for (const row of announced) push(row.provider);
  push(w.okxwallet);
  push(w.ethereum);
  for (const extra of w.ethereum?.providers ?? []) push(extra);
  return out;
}

/** OKX first: it injects window.okxwallet and may not take window.ethereum. */
export function getInjectedProvider(): EthereumProvider | undefined {
  const list = candidates();
  return list.find((p) => isOkx(p) || p === win().okxwallet) ?? list[0];
}

export function connectErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/4001|user rejected|rejected|denied/i.test(text)) {
    return "钱包拒绝了连接。请在 OKX / MetaMask 弹窗里确认。";
  }
  if (/no browser wallet|no injected|not detected/i.test(text)) {
    return "没检测到浏览器钱包。请安装 OKX 或 MetaMask 扩展后刷新，或用钱包内置浏览器打开此页。";
  }
  return text;
}

/** Browser-injected wallet only — avoids wagmi/connectors barrel (Coinbase/@x402). */
export function injected() {
  return createConnector((config) => {
    return {
      id: "injected",
      name: "Browser Wallet",
      type: "injected",
      async connect<withCapabilities extends boolean = false>(parameters?: {
        chainId?: number;
        isReconnecting?: boolean;
        withCapabilities?: withCapabilities | boolean;
      }) {
        const provider = getInjectedProvider();
        if (!provider) throw new Error("No browser wallet detected (OKX / MetaMask / Rabby)");
        const raw = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        const accounts = raw.map((a) => getAddress(a)) as Address[];
        const chainId = Number((await provider.request({ method: "eth_chainId" })) as string);
        if (parameters?.withCapabilities) {
          return {
            accounts: accounts.map((address) => ({ address, capabilities: {} })),
            chainId,
          } as never;
        }
        return { accounts, chainId } as never;
      },
      async disconnect() {},
      async getAccounts() {
        const provider = getInjectedProvider();
        if (!provider) return [];
        const raw = (await provider.request({ method: "eth_accounts" })) as string[];
        return raw.map((a) => getAddress(a)) as Address[];
      },
      async getChainId() {
        const provider = getInjectedProvider();
        if (!provider) return config.chains[0].id;
        return Number((await provider.request({ method: "eth_chainId" })) as string);
      },
      async getProvider() {
        return getInjectedProvider();
      },
      async isAuthorized() {
        const accounts = await this.getAccounts();
        return accounts.length > 0;
      },
      async switchChain({ chainId }) {
        const provider = getInjectedProvider();
        if (!provider) throw new Error("No browser wallet detected");
        const chain = config.chains.find((item) => item.id === chainId);
        if (!chain) throw new Error(`Unsupported chain ${chainId}`);
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: numberToHex(chainId) }],
          });
        } catch {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: numberToHex(chainId),
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: chain.rpcUrls.default.http,
                blockExplorerUrls: chain.blockExplorers?.default ? [chain.blockExplorers.default.url] : [],
              },
            ],
          });
        }
        return chain;
      },
      onAccountsChanged(accounts) {
        if (accounts.length === 0) config.emitter.emit("disconnect");
        else config.emitter.emit("change", { accounts: accounts.map((a) => getAddress(a)) as Address[] });
      },
      onChainChanged(chain) {
        config.emitter.emit("change", { chainId: Number(chain) });
      },
      onDisconnect() {
        config.emitter.emit("disconnect");
      },
    };
  });
}
