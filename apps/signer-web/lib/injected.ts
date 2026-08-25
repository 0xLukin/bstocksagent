import { createConnector } from "wagmi";
import { getAddress, numberToHex, type Address } from "viem";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function getEthereum(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { ethereum?: EthereumProvider }).ethereum;
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
        const provider = getEthereum();
        if (!provider) throw new Error("未检测到浏览器钱包（MetaMask / Rabby 等）");
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
        const provider = getEthereum();
        if (!provider) return [];
        const raw = (await provider.request({ method: "eth_accounts" })) as string[];
        return raw.map((a) => getAddress(a)) as Address[];
      },
      async getChainId() {
        const provider = getEthereum();
        if (!provider) return config.chains[0].id;
        return Number((await provider.request({ method: "eth_chainId" })) as string);
      },
      async getProvider() {
        return getEthereum();
      },
      async isAuthorized() {
        const accounts = await this.getAccounts();
        return accounts.length > 0;
      },
      async switchChain({ chainId }) {
        const provider = getEthereum();
        if (!provider) throw new Error("未检测到浏览器钱包");
        const chain = config.chains.find((item) => item.id === chainId);
        if (!chain) throw new Error(`不支持的链 ${chainId}`);
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
