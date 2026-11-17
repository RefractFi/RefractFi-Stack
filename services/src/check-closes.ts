// Coverage check: every 5 s window close in [from, now-10] must have an exact-timestamp price for each feed.
// Usage: bun src/check-closes.ts <fromUnixSeconds>
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { chain, deploy } from "./config";

const from = Math.ceil(Number(process.argv[2]) / 5) * 5;
const to = Math.floor((Date.now() / 1000 - 10) / 5) * 5;
if (!from || to < from) throw new Error("usage: bun src/check-closes.ts <fromUnixSeconds>");

const pub = createPublicClient({ chain, transport: http(), batch: { multicall: false } });
const abi = parseAbi(["function priceAt(bytes32 feedId, uint64 ts) view returns (int256, bool)"]);
const feed = deploy.contracts.StreamsFeed.address as Hex;

for (const [name, id] of Object.entries(deploy.feeds).filter(([k]) => k.includes("/"))) {
  const missing: number[] = [];
  let last = 0n;
  for (let ts = from; ts <= to; ts += 5) {
    try {
      [last] = await pub.readContract({ address: feed, abi, functionName: "priceAt", args: [id as Hex, BigInt(ts)] });
    } catch {
      missing.push(ts);
    }
  }
  const total = (to - from) / 5 + 1;
  console.log(`${name}: ${total - missing.length}/${total} closes priced, last ${Number(last / 10n ** 16n) / 100}` +
    (missing.length ? `, missing ${missing.slice(0, 10).join(",")}${missing.length > 10 ? "…" : ""}` : ""));
}
