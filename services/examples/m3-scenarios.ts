// M3 live check on testnet: set up each case as owner/agent, then WAIT for the Railway keepers to act.
// Passes only if the settle / cut / liquidation tx came from the keeper wallets, not from this script.
// Run from services/: bun --env-file=../.env examples/m3-scenarios.ts
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { chain, deploy } from "../src/config";

const E = deploy.contracts.RefractEngine.address as Hex;
const USDG = deploy.contracts.MockUSDG.address as Hex;
const SETTLER = deploy.accounts.settler.toLowerCase();
const KEEPER = deploy.accounts.keeper.toLowerCase();
const BTC = 0n;

const abi = parseAbi([
  "function mint(address to, uint256 amt)",
  "function approve(address s, uint256 amt) returns (bool)",
  "function openCrystal() returns (uint256)",
  "function deposit(uint256 pid, uint256 amount)",
  "function withdraw(uint256 pid, uint256 amount)",
  "function setBeam(uint256 pid, uint256 bid, (address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap) p)",
  "function cutBeam(uint256 pid, uint256 bid)",
  "function trade(uint256 pid, uint256 bid, uint256 m, int256 size, int256 limitPrice)",
  "function queueCross(uint256 pid, uint256 bid, uint256 m, int256 size, uint16 maxSlipBps)",
  "function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)",
  "event CrystalOpened(uint256 indexed crystal, address indexed owner)",
  "event Queued(uint256 indexed market, uint64 indexed window, uint256 crystal, uint256 beam, int256 size)",
  "event WindowSettled(uint256 indexed market, uint64 indexed window, int256 matched, int256 residual, bool residualFilled, int256 mark)",
  "event BeamState_(uint256 indexed crystal, uint256 indexed beam, uint8 state, int256 equity, int256 hwm)",
  "event Flattened(uint256 indexed crystal, bool liquidation, int256 fee)",
]);

const pub = createPublicClient({ chain, transport: http() });
const acct = (k: string) => privateKeyToAccount(process.env[k] as Hex, { nonceManager });
const owner = acct("DEPLOYER_PK");
const agent = acct("AGENT_PK");
const w = (a: typeof owner) => createWalletClient({ chain, account: a, transport: http() });

async function send(a: typeof owner, address: Hex, functionName: string, args: unknown[]) {
  const { request, result } = await pub.simulateContract({ account: a, address, abi, functionName: functionName as never, args: args as never });
  const hash = await w(a).writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} failed ${hash}`);
  return { result, r };
}

const U = (x: number) => parseUnits(String(x), 6);
const W = (x: number) => parseUnits(String(x), 18);
const until = () => BigInt(Math.floor(Date.now() / 1000) + 86400);

async function crystal(dep: number): Promise<bigint> {
  await send(owner, USDG, "mint", [owner.address, U(dep)]);
  await send(owner, USDG, "approve", [E, U(dep)]);
  const { r } = await send(owner, E, "openCrystal", []);
  const log = (await pub.getContractEvents({ address: E, abi, eventName: "CrystalOpened", fromBlock: r.blockNumber, toBlock: r.blockNumber }))[0];
  const pid = (log.args as { crystal: bigint }).crystal;
  await send(owner, E, "deposit", [pid, U(dep)]);
  return pid;
}

const beam = (pid: bigint, bid: bigint, budget: number, soft: number, hard: number) =>
  send(owner, E, "setBeam", [pid, bid, { agent: agent.address, until: until(), marketMask: 3, softBps: soft, hardBps: hard, perfFeeBps: 0, budget: W(budget), levCap: W(10) }]);

/** Poll for an event matching `pred` until timeout; return it with the tx sender. */
async function waitFor(eventName: string, from: bigint, pred: (args: any) => boolean, secs = 120) {
  for (let t = 0; t < secs; t += 3) {
    const logs: any[] = await pub.getContractEvents({ address: E, abi, eventName: eventName as never, fromBlock: from });
    const hit = logs.find((l) => pred(l.args));
    if (hit) return { args: hit.args as any, from: (await pub.getTransaction({ hash: hit.transactionHash })).from.toLowerCase() };
    await Bun.sleep(3000);
  }
  throw new Error(`timed out waiting for ${eventName}`);
}

const results: string[] = [];
const ok = (cond: boolean, msg: string) => { results.push(`${cond ? "PASS" : "FAIL"} ${msg}`); console.log(results.at(-1)); };

// A. Crossing: two crystals, opposite 0.01 BTC in the same 5 s window -> settler settles at the close mark.
{
  const a = await crystal(500), b = await crystal(500);
  await beam(a, 0n, 500, 500, 750);
  await beam(b, 0n, 500, 500, 750);
  let win = -1n, start = 0n;
  for (let tries = 0; tries < 3 && win < 0n; tries++) {
    start = await pub.getBlockNumber();
    const [x, y] = await Promise.all([
      send(agent, E, "queueCross", [a, 0n, BTC, W(0.01), 50]),
      send(agent, E, "queueCross", [b, 0n, BTC, -W(0.01), 50]),
    ]);
    const q = await pub.getContractEvents({ address: E, abi, eventName: "Queued", fromBlock: x.r.blockNumber < y.r.blockNumber ? x.r.blockNumber : y.r.blockNumber });
    const ws = new Set(q.filter((l) => [a, b].includes((l.args as any).crystal)).map((l) => (l.args as any).window));
    if (ws.size === 1) win = [...ws][0] as bigint;
    else console.log("orders landed in different windows, retrying");
  }
  const s = await waitFor("WindowSettled", start, (g) => g.market === BTC && g.window === win);
  ok(s.from === SETTLER, `A cross: window ${win} settled by keeper (${s.from === SETTLER ? "settler" : s.from})`);
  ok(s.args.matched === W(0.01) && s.args.residual === 0n, `A cross: matched ${Number(s.args.matched) / 1e18} BTC, residual ${s.args.residual} (nothing to the Lens)`);
}

// B. Hard stop: 0.02% hard stop; the 5 bps opening fee alone breaches it -> enforcer cuts the beam.
{
  const pid = await crystal(200);
  await beam(pid, 0n, 200, 1, 2);
  const { r } = await send(agent, E, "trade", [pid, 0n, BTC, W(0.01), 0n]);
  const c = await waitFor("BeamState_", r.blockNumber, (g) => g.crystal === pid && g.state === 3);
  ok(c.from === KEEPER, `B hard stop: crystal ${pid} beam 0 cut by keeper (${c.from === KEEPER ? "enforcer" : c.from})`);
}

// C. Liquidation: long + short 0.1 BTC on $500 (net 0), withdraw to ~$50, cut the short ->
//    net long 0.1 BTC with MM ~$178 > equity -> liquidator flattens it.
{
  const pid = await crystal(500);
  await beam(pid, 0n, 1000, 500, 750);
  await beam(pid, 1n, 1000, 500, 750);
  await send(agent, E, "trade", [pid, 0n, BTC, W(0.1), 0n]);
  await send(agent, E, "trade", [pid, 1n, BTC, -W(0.1), 0n]);
  const [eq] = await pub.readContract({ address: E, abi, functionName: "crystalRisk", args: [pid] });
  await send(owner, E, "withdraw", [pid, eq / 10n ** 12n - U(50)]);
  const { r } = await send(owner, E, "cutBeam", [pid, 1n]);
  const [eq2, , mm] = await pub.readContract({ address: E, abi, functionName: "crystalRisk", args: [pid] });
  console.log(`   after cut: equity $${Number(eq2) / 1e18} vs maintenance $${Number(mm) / 1e18}`);
  const f = await waitFor("Flattened", r.blockNumber, (g) => g.crystal === pid && g.liquidation === true);
  ok(f.from === KEEPER, `C liquidation: crystal ${pid} liquidated by keeper (${f.from === KEEPER ? "liquidator" : f.from}), fee $${Number(f.args.fee) / 1e18}`);
}

console.log(results.every((x) => x.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
