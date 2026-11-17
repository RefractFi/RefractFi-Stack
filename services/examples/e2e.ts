// End-to-end testnet scenario mirroring the overview PDF §3, run against the live system (keepers on Railway).
// Run from services/: bun --env-file=../.env examples/e2e.ts
// Sizes: BTC is ~$64k on testnet, so the crossing leg is scaled to 0.3 vs 0.2 BTC (same 3:2 shape as the PDF).
import { createClient } from "@supabase/supabase-js";
import { createWalletClient, http, parseAbi, parseUnits, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { chain, deploy } from "../src/config";
import { pub } from "../src/chain";

const E = deploy.contracts.RefractEngine.address as Hex;
const USDG = deploy.contracts.MockUSDG.address as Hex;
const BTC = 0n;
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const abi = parseAbi([
  "function mint(address to, uint256 amt)", "function approve(address s, uint256 amt) returns (bool)", "function balanceOf(address) view returns (uint256)",
  "function openCrystal() returns (uint256)", "function deposit(uint256 pid, uint256 amount)", "function withdraw(uint256 pid, uint256 amount)",
  "function setBeam(uint256 pid, uint256 bid, (address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap) p)",
  "function trade(uint256 pid, uint256 bid, uint256 m, int256 size, int256 limitPrice)",
  "function queueCross(uint256 pid, uint256 bid, uint256 m, int256 size, uint16 maxSlipBps)",
  "function flatten(uint256 pid)", "function pauseOpens(bool on)",
  "function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)", "function grossMargin(uint256 pid) view returns (int256)",
  "function crystalCount() view returns (uint256)", "function crystals(uint256) view returns (address owner, uint8 beamCount, uint32 openMask, int256 collateral, int256 netDeposits, int256 perfPaid, int256 liqPaid, int256 badDebt, int256 pending)",
  "function poolCash() view returns (int256)", "function protocolFees() view returns (int256)",
  "event CrystalOpened(uint256 indexed crystal, address indexed owner)",
  "event Queued(uint256 indexed market, uint64 indexed window, uint256 crystal, uint256 beam, int256 size)",
  "event WindowSettled(uint256 indexed market, uint64 indexed window, int256 matched, int256 residual, bool residualFilled, int256 mark)",
  "event BeamState_(uint256 indexed crystal, uint256 indexed beam, uint8 state, int256 equity, int256 hwm)",
]);
const owner = privateKeyToAccount(process.env.DEPLOYER_PK as Hex, { nonceManager });
const agent = privateKeyToAccount(process.env.AGENT_PK as Hex, { nonceManager });
const guardian = privateKeyToAccount(process.env.GUARDIAN_PK as Hex, { nonceManager });
async function send(a: typeof owner, address: Hex, fn: string, args: unknown[] = []) {
  const { request } = await pub.simulateContract({ account: a, address, abi, functionName: fn as never, args: args as never });
  const r = await pub.waitForTransactionReceipt({ hash: await createWalletClient({ chain, account: a, transport: http() }).writeContract(request) });
  if (r.status !== "success") throw new Error(`${fn} failed`);
  return r;
}
const read = (fn: string, args: unknown[] = []) => pub.readContract({ address: E, abi, functionName: fn as never, args: args as never }) as Promise<any>;
const W = (x: number) => parseUnits(String(x), 18), U = (x: number) => parseUnits(String(x), 6);
const $ = (x: bigint) => (Number(x) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 });
const results: string[] = [];
const ok = (c: boolean, m: string) => { results.push(`${c ? "PASS" : "FAIL"} ${m}`); console.log(results.at(-1)); };
const until = () => BigInt(Math.floor(Date.now() / 1000) + 86400);

async function conserved(step: string) {
  const n = await read("crystalCount");
  let sum = (await read("poolCash")) + (await read("protocolFees"));
  for (let i = 1n; i <= n; i++) sum += (await read("crystals", [i]))[3];
  const held = (await pub.readContract({ address: USDG, abi, functionName: "balanceOf", args: [E] })) * 10n ** 12n;
  ok(held === sum, `${step}: USDG held = Σ collateral + Lens + fees, exactly`);
}
async function crystal(dep: number) {
  await send(owner, USDG, "mint", [owner.address, U(dep)]);
  await send(owner, USDG, "approve", [E, U(dep)]);
  const r = await send(owner, E, "openCrystal");
  const pid = (await pub.getContractEvents({ address: E, abi, eventName: "CrystalOpened", fromBlock: r.blockNumber, toBlock: r.blockNumber }))[0].args.crystal!;
  await send(owner, E, "deposit", [pid, U(dep)]);
  return pid;
}
const beam = (pid: bigint, bid: bigint, budget: number, lev: number, softBps: number, hardBps: number) =>
  send(owner, E, "setBeam", [pid, bid, { agent: agent.address, until: until(), marketMask: 1, softBps, hardBps, perfFeeBps: 1000, budget: W(budget), levCap: W(lev) }]);
async function waitEvent(name: string, from: bigint, pred: (a: any) => boolean, secs = 120) {
  for (let t = 0; t < secs; t += 3) {
    const hit = (await pub.getContractEvents({ address: E, abi, eventName: name as never, fromBlock: from }) as any[]).find((l) => pred(l.args));
    if (hit) return { args: hit.args, from: (await pub.getTransaction({ hash: hit.transactionHash })).from.toLowerCase() };
    await Bun.sleep(3000);
  }
  throw new Error(`timed out waiting for ${name}`);
}

// 1. Alice: $15,000, Trend long 2 BTC, Revert short 2 BTC. Revert has a tiny hard stop so step 2 can trip it.
console.log("1. Netting");
const alice = await crystal(15_000);
await beam(alice, 0n, 7_000, 20, 500, 750); // Trend
await beam(alice, 1n, 7_000, 20, 1, 2); // Revert (2 bps hard stop: the opening fee breaches it)
await send(agent, E, "trade", [alice, 0n, BTC, W(2), 0n]);
const rev = await send(agent, E, "trade", [alice, 1n, BTC, -W(2), 0n]);
const [, im] = await read("crystalRisk", [alice]);
const gross = await read("grossMargin", [alice]);
ok(im === 0n, `net margin $${$(im)} for long 2 + short 2 BTC (each alone would need $${$(gross / 2n)}; together $${$(gross)})`);
await conserved("after netting");

// 2. Revert hits its hard stop: the enforcer cuts it; Trend keeps trading; margin rises to Trend's alone.
console.log("2. Hard stop");
const cut = await waitEvent("BeamState_", rev.blockNumber, (a) => a.crystal === alice && a.beam === 1n && a.state === 3);
ok(cut.from === deploy.accounts.keeper.toLowerCase(), "Revert cut by the enforcer keeper");
await send(agent, E, "trade", [alice, 0n, BTC, W(0.01), 0n]);
const [eqA, imA] = await read("crystalRisk", [alice]);
ok(imA > 0n && eqA > imA, `Trend kept trading; margin now $${$(imA)} on equity $${$(eqA)}`);
let alert = false;
for (let t = 0; t < 40 && !alert; t++) {
  alert = !!(await db.from("alerts").select("id").eq("kind", "cut").eq("crystal", Number(alice)).eq("beam", 1).limit(1)).data?.length;
  if (!alert) await Bun.sleep(3000);
}
ok(alert, "owner alert written for the cut (dashboard + Telegram if linked)");
await conserved("after the cut");

// 3. Crossing: Alice's agent buys 0.3 BTC while Bob's sells 0.2 in one window -> 0.2 cross at the mark, 0.1 to the Lens.
console.log("3. Crossing");
await beam(alice, 2n, 5_000, 20, 500, 750);
const bob = await crystal(5_000);
await beam(bob, 0n, 5_000, 20, 500, 750);
let win = -1n, from = 0n;
for (let tries = 0; tries < 3 && win < 0n; tries++) {
  from = await pub.getBlockNumber();
  const [x, y] = await Promise.all([
    send(agent, E, "queueCross", [alice, 2n, BTC, W(0.3), 100]),
    send(agent, E, "queueCross", [bob, 0n, BTC, -W(0.2), 100]),
  ]);
  const q = await pub.getContractEvents({ address: E, abi, eventName: "Queued", fromBlock: x.blockNumber < y.blockNumber ? x.blockNumber : y.blockNumber });
  const ws = new Set(q.filter((l) => [alice, bob].includes(l.args.crystal!)).map((l) => l.args.window!));
  if (ws.size === 1) win = [...ws][0]; else console.log("   orders landed in different windows, retrying");
}
const s = await waitEvent("WindowSettled", from, (a) => a.market === BTC && a.window === win);
ok(s.from === deploy.accounts.settler.toLowerCase(), `window ${win} settled by the settler keeper`);
ok(s.args.matched === W(0.2) && s.args.residual === W(0.1) && s.args.residualFilled, `0.2 BTC crossed at the mark ($${$(s.args.mark)}), 0.1 BTC residual filled by the Lens`);
await conserved("after crossing");

// 4. Guardian pauses new risk: flatten + withdraw still work (exits never pause).
console.log("4. Exits while paused");
await send(guardian, E, "pauseOpens", [true]);
try {
  for (const pid of [alice, bob]) {
    await send(owner, E, "flatten", [pid]);
    const [eq] = await read("crystalRisk", [pid]);
    await send(owner, E, "withdraw", [pid, eq / 10n ** 12n]);
  }
  ok(true, "flatten + withdraw of both crystals while opens were paused");
} finally {
  await send(guardian, E, "pauseOpens", [false]);
}
await conserved("after exits");

console.log(results.every((x) => x.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
