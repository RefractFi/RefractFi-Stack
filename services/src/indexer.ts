// indexer: engine / registry / trace-roots events -> Supabase.
// Raw events go to `events`; fills and windows come straight from their events; crystal, beam, LP, listing and
// market state is RE-READ from the chain whenever an event touches it, so the DB can't drift from the contract.
// Every 30 s it snapshots live beam equity (beam_eq) and the Lens (lens_nav).
// ponytail: re-orgs handled only by a 2-block confirmation lag + idempotent upserts; enough on an Arbitrum-style
// chain with a single sequencer. Re-read the last N blocks if deep re-orgs ever show up.
import { createClient } from "@supabase/supabase-js";
import { decodeEventLog, parseAbi, type Hex, type Log } from "viem";
import { deploy, env } from "./config";
import { pub, scrub } from "./chain";
import { safeUri } from "./safeUri";

const E = deploy.contracts.RefractEngine.address.toLowerCase() as Hex;
const R = deploy.contracts.SpectrumRegistry.address.toLowerCase() as Hex;
const T = deploy.contracts.TraceRoots.address.toLowerCase() as Hex;
const CONFIRMATIONS = 2n;
const MAX_RANGE = 2000n;
const SNAPSHOT_MS = 30_000;
const STATES = ["None", "Active", "Halved", "Cut"];
// Progress is keyed by engine address: a redeployed engine starts from its own deploy block, and a leftover
// container still running the old engine can never move the new one's cursor.
const STATE_ID = `engine:${E}`;

const abi = parseAbi([
  "event MarketListed(uint256 indexed market, bytes32 feedId)",
  "event CrystalOpened(uint256 indexed crystal, address indexed owner)",
  "event Deposited(uint256 indexed crystal, uint256 amount)",
  "event Withdrawn(uint256 indexed crystal, uint256 amount)",
  "event BeamSet(uint256 indexed crystal, uint256 indexed beam, address agent)",
  "event BeamState_(uint256 indexed crystal, uint256 indexed beam, uint8 state, int256 equity, int256 hwm)",
  "event Filled(uint256 indexed crystal, uint256 indexed beam, uint256 indexed market, int256 size, int256 price, int256 fee, bool crossed)",
  "event Queued(uint256 indexed market, uint64 indexed window, uint256 crystal, uint256 beam, int256 size)",
  "event WindowSettled(uint256 indexed market, uint64 indexed window, int256 matched, int256 residual, bool residualFilled, int256 mark)",
  "event Flattened(uint256 indexed crystal, bool liquidation, int256 fee)",
  "event Crystallized(uint256 indexed crystal, uint256 indexed beam, address agent, uint256 paid)",
  "event LpDeposit(address indexed lp, uint256 amount, uint256 shares)",
  "event LpWithdraw(address indexed lp, uint256 shares, uint256 paid)",
  "event Listed(address indexed agent, uint16 perfFeeBps, string uri)",
  "event Delisted(address indexed agent)",
  "event Committed(uint64 indexed epoch, bytes32 root, uint32 leaves)",
  "event CapsSet(uint256 lensCap, uint256 crystalCap)",
]);
const views = parseAbi([
  "function crystals(uint256) view returns (address owner, uint8 beamCount, uint32 openMask, int256 collateral, int256 netDeposits, int256 perfPaid, int256 liqPaid, int256 badDebt, int256 pending)",
  "function beam(uint256 pid, uint256 bid) view returns (((address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap) p, uint8 state, uint32 openMask, int256 realized, int256 hwm, int256 feeHwm, uint64 lastCrystal, int256 pending))",
  "function market(uint256 m) view returns (((bytes32 feedId, int256 maxLev, int256 mmr, uint16 takerFeeBps, uint16 crossFeeBps, int256 skewScale, int256 maxFundingPerDay, int256 maxSkew, uint32 maxAge) p, bool listed, int256 skew, int256 sumSL, int256 sumSF, int256 fundingIndex, uint64 lastAccrual))",
  "function marketCount() view returns (uint256)",
  "function beamEquity(uint256 pid, uint256 bid) view returns (int256)",
  "function sharesOf(address) view returns (uint256)",
  "function poolNav() view returns (int256)",
  "function poolCash() view returns (int256)",
  "function lensReserve() view returns (int256)",
  "function totalShares() view returns (uint256)",
  "function listings(address) view returns (uint16 perfFeeBps, bool active, uint64 listedAt, string uri)",
]);

export const status = { lastPoll: 0, lastBlock: 0, events: 0, snapshots: 0, lastErr: "" };

const db = () => createClient(env.need("SUPABASE_URL"), env.need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
type DB = ReturnType<typeof db>;

/** bigint -> string everywhere, so rows and jsonb survive JSON. */
export const plain = (v: unknown): any =>
  typeof v === "bigint" ? v.toString()
  : Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;

async function must<T>(p: PromiseLike<{ error: any; data?: T }>, what: string) {
  const { error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
}

const read = (address: Hex, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi: views, functionName: functionName as never, args: args as never }) as Promise<any>;
const iso = (secs: bigint | number) => new Date(Number(secs) * 1000).toISOString();

async function refreshCrystal(d: DB, pid: bigint, openedAt?: string) {
  const c = await read(E, "crystals", [pid]);
  await must(d.from("crystals").upsert(plain({
    id: pid, owner: c[0].toLowerCase(), beam_count: c[1], open_mask: c[2], collateral: c[3], net_deposits: c[4],
    perf_paid: c[5], liq_paid: c[6], bad_debt: c[7], pending: c[8], updated_at: new Date().toISOString(),
    ...(openedAt ? { opened_at: openedAt } : {}),
  })), "crystals");
  const beams = [];
  for (let bid = 0n; bid < BigInt(c[1]); bid++) {
    const b = await read(E, "beam", [pid, bid]);
    beams.push(plain({
      crystal: pid, beam: bid, agent: b.p.agent.toLowerCase(), until: iso(b.p.until), market_mask: b.p.marketMask,
      soft_bps: b.p.softBps, hard_bps: b.p.hardBps, perf_bps: b.p.perfFeeBps, budget: b.p.budget, lev_cap: b.p.levCap,
      state: STATES[b.state], open_mask: b.openMask, realized: b.realized, hwm: b.hwm, fee_hwm: b.feeHwm,
      pending: b.pending, updated_at: new Date().toISOString(),
    }));
  }
  if (beams.length) await must(d.from("beams").upsert(beams), "beams");
}

async function refreshMarket(d: DB, m: bigint) {
  const x = await read(E, "market", [m]);
  await must(d.from("markets").upsert(plain({
    id: m, feed_id: x.p.feedId, max_lev: x.p.maxLev, mmr: x.p.mmr, taker_bps: x.p.takerFeeBps,
    cross_bps: x.p.crossFeeBps, skew_scale: x.p.skewScale, max_funding_day: x.p.maxFundingPerDay,
    max_skew: x.p.maxSkew, max_age: x.p.maxAge, skew: x.skew, updated_at: new Date().toISOString(),
  })), "markets");
}

async function indexRange(d: DB, from: bigint, to: bigint) {
  const logs = await pub.getLogs({ address: [E, R, T], fromBlock: from, toBlock: to });
  if (!logs.length) return 0;
  const times = new Map<bigint, string>();
  for (const b of new Set(logs.map((l) => l.blockNumber!))) times.set(b, iso((await pub.getBlock({ blockNumber: b })).timestamp));

  const events = [], fills = [], windows = [], roots = [];
  const crystals = new Map<bigint, string | undefined>(), markets = new Set<bigint>(), lps = new Set<string>(), agents = new Set<string>();
  for (const l of logs as Log[]) {
    let ev;
    try { ev = decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { continue; } // e.g. pusher's feed events
    const a = ev.args as any, at = times.get(l.blockNumber!)!;
    events.push(plain({
      tx_hash: l.transactionHash, log_index: l.logIndex, block_number: l.blockNumber, block_time: at,
      contract: l.address.toLowerCase() === E ? "engine" : l.address.toLowerCase() === R ? "spectrum" : "roots",
      name: ev.eventName, crystal: a.crystal ?? null, beam: a.beam ?? null, market: a.market ?? null, args: a,
    }));
    if (a.crystal !== undefined && l.address.toLowerCase() === E) {
      if (!crystals.has(a.crystal)) crystals.set(a.crystal, undefined);
      if (ev.eventName === "CrystalOpened") crystals.set(a.crystal, at);
    }
    switch (ev.eventName) {
      case "Filled":
        fills.push(plain({ tx_hash: l.transactionHash, log_index: l.logIndex, block_time: at, crystal: a.crystal, beam: a.beam, market: a.market, size: a.size, price: a.price, fee: a.fee, crossed: a.crossed }));
        markets.add(a.market);
        break;
      case "WindowSettled":
        windows.push(plain({ market: a.market, window: a.window, matched: a.matched, residual: a.residual, residual_filled: a.residualFilled, mark: a.mark, voided: a.mark === 0n, settled_tx: l.transactionHash, block_time: at }));
        markets.add(a.market);
        break;
      case "MarketListed": markets.add(a.market); break;
      case "LpDeposit": case "LpWithdraw": lps.add(a.lp.toLowerCase()); break;
      case "Listed": case "Delisted": agents.add(a.agent.toLowerCase()); break;
      case "Committed": roots.push(plain({ epoch: a.epoch, root: a.root, leaves: a.leaves, tx_hash: l.transactionHash, block_time: at })); break;
    }
  }

  await must(d.from("events").upsert(events, { ignoreDuplicates: true }), "events");
  if (fills.length) await must(d.from("fills").upsert(fills, { ignoreDuplicates: true }), "fills");
  if (windows.length) await must(d.from("windows").upsert(windows), "windows");
  if (roots.length) await must(d.from("roots").upsert(roots), "roots");
  for (const m of markets) await refreshMarket(d, m);
  for (const [pid, openedAt] of crystals) await refreshCrystal(d, pid, openedAt);
  for (const lp of lps) {
    const shares = await read(E, "sharesOf", [lp]);
    await must(d.from("lp_positions").upsert(plain({ lp, shares, updated_at: new Date().toISOString() })), "lp_positions");
  }
  for (const agent of agents) {
    const [perf, active, listedAt, uri] = await read(R, "listings", [agent]);
    await must(d.from("spectrum").upsert({ agent, perf_bps: perf, active, listed_at: iso(listedAt), uri: safeUri(uri) ?? "", updated_at: new Date().toISOString() }), "spectrum");
  }
  return events.length;
}

async function snapshot(d: DB) {
  const ts = new Date().toISOString();
  const { data: live, error } = await d.from("beams").select("crystal,beam").in("state", ["Active", "Halved"]);
  if (error) throw new Error(`beams: ${error.message}`);
  const rows = [];
  for (const { crystal, beam } of live ?? []) {
    const [equity, b] = await Promise.all([read(E, "beamEquity", [BigInt(crystal), BigInt(beam)]), read(E, "beam", [BigInt(crystal), BigInt(beam)])]);
    rows.push(plain({ crystal, beam, ts, equity, hwm: b.hwm, state: STATES[b.state] }));
  }
  if (rows.length) await must(d.from("beam_eq").insert(rows), "beam_eq");

  const n = await read(E, "marketCount");
  const skew: Record<string, string> = {};
  for (let m = 0n; m < n; m++) {
    const x = await read(E, "market", [m]);
    skew[m.toString()] = x.skew.toString();
    await must(d.from("markets").update({ skew: x.skew.toString(), updated_at: ts }).eq("id", Number(m)), "markets skew");
  }
  const [nav, cash, reserve, shares] = await Promise.all([read(E, "poolNav"), read(E, "poolCash"), read(E, "lensReserve"), read(E, "totalShares")]);
  await must(d.from("lens_nav").insert(plain({ ts, nav, cash, reserve, total_shares: shares, skew })), "lens_nav");
  status.snapshots++;
}

export async function startIndexer() {
  const d = db();
  const { data } = await d.from("indexer_state").select("last_block").eq("id", STATE_ID).maybeSingle();
  let next = data ? BigInt(data.last_block) + 1n : BigInt(deploy.deployBlock!);
  console.log(`[indexer] from block ${next} into ${env.need("SUPABASE_URL")}`);
  let lastSnap = 0;
  for (;;) {
    try {
      const head = (await pub.getBlockNumber()) - CONFIRMATIONS;
      while (next <= head) {
        const to = next + MAX_RANGE - 1n < head ? next + MAX_RANGE - 1n : head;
        const n = await indexRange(d, next, to);
        await must(d.from("indexer_state").upsert({ id: STATE_ID, last_block: Number(to), updated_at: new Date().toISOString() }), "indexer_state");
        status.events += n;
        status.lastBlock = Number(to);
        if (n) console.log(`[indexer] blocks ${next}-${to}: ${n} events`);
        next = to + 1n;
      }
      if (Date.now() - lastSnap >= SNAPSHOT_MS) { await snapshot(d); lastSnap = Date.now(); }
      status.lastPoll = Date.now();
    } catch (e) {
      status.lastErr = scrub(e);
      console.error(`[indexer] ${status.lastErr}`);
    }
    await Bun.sleep(2000);
  }
}
