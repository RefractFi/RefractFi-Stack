import deployment from "../../deployments/testnet.json";
import { defineChain, type Hex } from "viem";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const chain = defineChain({
  id: deployment.chainId,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? deployment.rpc] } },
});

export const deploy = deployment;
export const env = { need, get: (n: string) => process.env[n] };
export const pk = (name: string) => need(name) as Hex;
