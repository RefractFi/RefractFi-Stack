// M8 live check: equity markets follow US hours. Two phases across a real market close.
//   bun --env-file=../.env examples/m8-equities.ts open     (during US hours) opens the positions
//   bun --env-file=../.env examples/m8-equities.ts closed   (after 16:00 ET)  runs the off-hours checks
// Off-hours rules (PDF §5): increases refused, reductions allowed, liquidation on the held price.
import { createWalletClient, http, parseAbi, parseUnits, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { chain, deploy } from "../src/config";
import { pub, revertName } from "../src/chain";
import { usMarketOpen } from "../src/pusher";

const E = deploy.contracts.RefractEngine.address as Hex;
const USDG = deploy.contracts.MockUSDG.address as Hex;
const FEED = deploy.contracts.StreamsFeed.address as Hex;
const NVDA = 2n;
const STATE = process.env.M8_STATE ?? "./m8-state.json";
const abi = parseAbi([
  "function mint(address to, uint256 amt)", "function approve(address s, uint256 amt) returns (bool)",
  "function openCrystal() returns (uint256)", "function deposit(uint256 pid, uint256 amount)", "function withdraw(uint256 pid, uint256 amount)",
  "function setBeam(uint256 pid, uint256 bid, (address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap) p)",
  "function cutBeam(uint256 pid, uint256 bid)", "function trade(uint256 pid, uint256 bid, uint256 m, int256 size, int256 limitPrice)",
  "function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)",
  "function latest(bytes32 feedId) view returns (int256 price, uint64 observedAt, bool open)",
  "function market(uint256 m) view returns (((bytes32 feedId, int256 maxLev, int256 mmr, uint16 takerFeeBps, uint16 crossFeeBps, int256 skewScale, int256 maxFundingPerDay, int256 maxSkew, uint32 maxAge) p, bool listed, int256 skew, int256 sumSL, int256 sumSF, int256 fundingIndex, uint64 lastAccrual))",
  "event CrystalOpened(uint256 indexed crystal, address indexed owner)",
  "event Flattened(uint256 indexed crystal, bool liquidation, int256 fee)",
  "error MarketClosed()", "error StalePrice()", "error InsufficientMargin()", "error OverBeamCap()",
]);
const owner = privateKeyToAccount(process.env.DEPLOYER_PK as Hex, { nonceManager });
const agent = privateKeyToAccount(process.env.AGENT_PK as Hex, { nonceManager });
const w = (a: typeof owner) => createWalletClient({ chain, account: a, transport: http() });
async function send(a: typeof owner, address: Hex, fn: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: a, address, abi, functionName: fn as never, args: args as never });
  const r = await pub.waitForTransactionReceipt({ hash: await w(a).writeContract(request) });
  if (r.status !== "success") throw new Error(`${fn} failed`);
  return r;
}
const W = (x: number) => parseUnits(String(x), 18), U = (x: number) => parseUnits(String(x), 6);
const results: string[] = [];
const ok = (c: boolean, m: string) => { results.push(`${c ? "PASS" : "FAIL"} ${m}`); console.log(results.at(-1)); };

async function crystal(dep: number) {
  await send(owner, USDG, "mint", [owner.address, U(dep)]);
  await send(owner, USDG, "approve", [E, U(dep)]);
  const r = await send(owner, E, "openCrystal", []);
  const pid = (await pub.getContractEvents({ address: E, abi, eventName: "CrystalOpened", fromBlock: r.blockNumber, toBlock: r.blockNumber }))[0].args.crystal!;
  await send(owner, E, "deposit", [pid, U(dep)]);
  return pid;
}
// wide = stops the open-hours price moves can't reach, so the enforcer leaves a hedged pair intact until the close
const beam = (pid: bigint, bid: bigint, budget: number, wide = false) => send(owner, E, "setBeam", [pid, bid, {
  agent: agent.address, until: BigInt(Math.floor(Date.now() / 1000) + 3 * 86400), marketMask: 1 << Number(NVDA),
  softBps: wide ? 8000 : 500, hardBps: wide ? 9000 : 750, perfFeeBps: 0, budget: W(budget), levCap: W(10),
}]);

const phase = process.argv[2];
const feedId = (await pub.readContract({ address: E, abi, functionName: "market", args: [NVDA] })).p.feedId;
const [price, at, open] = await pub.readContract({ address: FEED, abi, functionName: "latest", args: [feedId] });
console.log(`NVDA feed: $${(Number(price) / 1e18).toFixed(2)}, ${open ? "OPEN" : "CLOSED"}, ${Math.floor(Date.now() / 1000) - Number(at)}s old`);

if (phase === "open") {
  if (!usMarketOpen(new Date()) || !open) throw new Error("run the open phase during US market hours");
  const a = await crystal(1000);
  await beam(a, 0n, 1000);
  await send(agent, E, "trade", [a, 0n, NVDA, W(2), 0n]); // long 2 NVDA
  const b = await crystal(500);
  await beam(b, 0n, 500, true);
  await beam(b, 1n, 500, true);
  await send(agent, E, "trade", [b, 0n, NVDA, W(20), 0n]); // long 20 NVDA (~$3.2k)
  await send(agent, E, "trade", [b, 1n, NVDA, -W(20), 0n]); // short 20: net zero, no margin
  await Bun.write(STATE, JSON.stringify({ a: a.toString(), b: b.toString(), openedAt: Date.now() }));
  console.log(`opened crystal ${a} (long 2 NVDA) and crystal ${b} (net-zero NVDA pair); run the closed phase after 16:00 ET`);
} else if (phase === "closed") {
  if (usMarketOpen(new Date()) || open) throw new Error("run the closed phase after 16:00 ET, once the feed says CLOSED");
  const st = JSON.parse(await Bun.file(STATE).text());
  const a = BigInt(st.a), b = BigInt(st.b);
  // The pusher keeps publishing the held close with status CLOSED (like real v8 streams), so trades can be priced.
  ok(!open && Math.floor(Date.now() / 1000) - Number(at) <= 30, "NVDA feed says CLOSED and is fresh (held close re-published)");

  let inc = "accepted";
  try { await pub.simulateContract({ account: agent, address: E, abi, functionName: "trade", args: [a, 0n, NVDA, W(1), 0n] }); } catch (e) { inc = revertName(e) ?? "reverted"; }
  ok(inc === "MarketClosed", `increase while closed refused: ${inc}`);

  const red = await send(agent, E, "trade", [a, 0n, NVDA, -W(1), 0n]).then(() => "filled", (e) => revertName(e) ?? String(e).slice(0, 80));
  ok(red === "filled", `reduction while closed allowed: ${red}`);

  // Crystal b: net zero, so the owner can take collateral out; cutting the short unhedges it below maintenance.
  const [eq] = await pub.readContract({ address: E, abi, functionName: "crystalRisk", args: [b] });
  await send(owner, E, "withdraw", [b, eq / 10n ** 12n - U(30)]);
  const cut = await send(owner, E, "cutBeam", [b, 1n]);
  const [eq2, , mm] = await pub.readContract({ address: E, abi, functionName: "crystalRisk", args: [b] });
  console.log(`   crystal ${b} after cut: equity $${(Number(eq2) / 1e18).toFixed(2)} vs maintenance $${(Number(mm) / 1e18).toFixed(2)}`);
  let liq: { from: string } | null = null;
  for (let t = 0; t < 60 && !liq; t++) {
    const logs = await pub.getContractEvents({ address: E, abi, eventName: "Flattened", fromBlock: cut.blockNumber });
    const hit = logs.find((l) => l.args.crystal === b && l.args.liquidation);
    if (hit) liq = { from: (await pub.getTransaction({ hash: hit.transactionHash })).from.toLowerCase() };
    else await Bun.sleep(3000);
  }
  ok(!!liq && liq.from === deploy.accounts.keeper.toLowerCase(), `liquidated by the keeper on the held closing price (market closed)`);
  console.log(results.every((x) => x.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
} else {
  console.log("usage: m8-equities.ts open|closed");
}
