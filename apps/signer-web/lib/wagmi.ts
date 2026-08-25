import { http, createConfig } from "wagmi";
import { bsc } from "wagmi/chains";
import { injected } from "./injected";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const config = createConfig({
  chains: [bsc],
  connectors: [injected()],
  transports: {
    [bsc.id]: http(process.env.NEXT_PUBLIC_BSC_RPC_URL ?? "https://bsc-rpc.publicnode.com"),
  },
  ssr: true,
});

export { projectId };
