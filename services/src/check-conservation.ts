// Law check on the live engine: USDG held == Σ crystal collateral + Lens cash + protocol fees, exactly.
// Usage: bun src/check-conservation.ts
import { parseAbi, type Hex } from "viem";
import { deploy } from "./config";
import { engine, engineAbi, pub } from "./chain";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const extra = parseAbi(["function poolCash() view returns (int256)", "function protocolFees() view returns (int256)"]);

const n = await pub.readContract({ address: engine, abi: engineAbi, functionName: "crystalCount" });
let collateral = 0n, badDebt = 0n;
for (let pid = 1n; pid <= n; pid++) {
  const c = await pub.readContract({ address: engine, abi: engineAbi, functionName: "crystals", args: [pid] });
  collateral += c[3];
  badDebt += c[7];
}
const [held, cash, fees] = await Promise.all([
  pub.readContract({ address: deploy.contracts.MockUSDG.address as Hex, abi: erc20, functionName: "balanceOf", args: [engine] }),
  pub.readContract({ address: engine, abi: extra, functionName: "poolCash" }),
  pub.readContract({ address: engine, abi: extra, functionName: "protocolFees" }),
]);
const lhs = held * 10n ** 12n, rhs = collateral + cash + fees;
const $ = (x: bigint) => (Number(x) / 1e18).toFixed(6);
console.log(`crystals ${n}: held ${$(lhs)} = collateral ${$(collateral)} + Lens ${$(cash)} + fees ${$(fees)}; bad debt ${$(badDebt)}`);
console.log(lhs === rhs ? "CONSERVED exactly" : `MISMATCH ${lhs - rhs}`);
if (lhs !== rhs) process.exit(1);
