// Gym (R3): paper seasons for agents, and Spectrum rankings.
// - Paper orders go through the SDK's checkBeamOrder (the engine's own beam rules) at live testnet marks, pay the
//   5 bps taker fee, and are subject to the SDK drawdownState stops. Agents finishing a season inside their rules
//   (not Cut, at least MIN_FILLS fills) are promoted.
// - Spectrum ranks listed agents ONLY from on-chain beam records with real budgets (PDF §11 "Sybil reputation").
// Agent actions are EIP-191 signatures over the canonical JSON of the action; each signature is single-use.
import { createClient } from "@supabase/supabase-js";
import { keccak256, parseAbi, recoverMessageAddress, toBytes, type Hex } from "viem";
import { checkBeamOrder } from "../../sdk/src/gate.js";
import { drawdownState, fee as takerFee, WAD, type BeamState } from "../../sdk/src/math.js";
import { canonical } from "../../sdk/src/traces.js";
import { deploy, env } from "./config";
import { pub, scrub } from "./chain";

const E = deploy.contracts.RefractEngine.address as Hex;
const FEED = deploy.contracts.StreamsFeed.address as Hex;
const MARKETS = deploy.markets.map((m: { id: number }) => m.id);
const ALL_MASK = MARKETS.reduce((m: number, id: number) => m | (1 << id), 0);
const TAKER_BPS = 5;
const MIN_FILLS = 3;
const MIN_FILL_NOTIONAL = 50n * WAD; // dust fills don't count toward promotion
const MIN_RANK_BUDGET = 500n * WAD; // agents need real budgets on-chain before they're ranked
const abi = parseAbi([
  "function opensPaused() view returns (bool)",
  "function market(uint256 m) view returns (((bytes32 feedId, int256 maxLev, int256 mmr, uint16 takerFeeBps, uint16 crossFeeBps, int256 skewScale, int256 maxFundingPerDay, int256 maxSkew, uint32 maxAge) p, bool listed, int256 skew, int256 sumSL, int256 sumSF, int256 fundingIndex, uint64 lastAccrual))",
  "function latest(bytes32 feedId) view returns (int256 price, uint64 observedAt, bool open)",
  "function beamEquity(uint256 pid, uint256 bid) view returns (int256)",
]);

// ---------- paper maths (pure) ----------
export type Pos = { size: bigint; entry: bigint };
const sign = (x: bigint) => (x > 0n ? 1n : x < 0n ? -1n : 0n);
const absB = (x: bigint) => (x < 0n ? -x : x);

/** Apply a paper fill. Returns the new position (undefined when flat) and the realized PnL change, fee included. */
export function paperFill(pos: Pos | undefined, size: bigint, price: bigint, feeBps = TAKER_BPS): { pos: Pos | undefined; realized: bigint } {
  const s0 = pos?.size ?? 0n, e0 = pos?.entry ?? 0n, s1 = s0 + size;
  if (size === 0n) return { pos, realized: 0n };
  let realized = -takerFee(size, price, feeBps);
  let entry = e0;
  if (s0 === 0n || sign(size) === sign(s0)) {
    entry = (absB(s0) * e0 + absB(size) * price) / absB(s1); // weighted average on increases
  } else {
    const closed = absB(size) < absB(s0) ? absB(size) : absB(s0);
    realized += (sign(s0) * closed * (price - e0)) / WAD;
    if (sign(s1) !== sign(s0) && s1 !== 0n) entry = price; // flipped: the remainder opens at this price
  }
  return { pos: s1 === 0n ? undefined : { size: s1, entry }, realized };
}

export function paperEquity(budget: bigint, realized: bigint, positions: Record<string, Pos>, marks: Record<string, bigint>): bigint {
  let eq = budget + realized;
  for (const [m, p] of Object.entries(positions)) if (marks[m] !== undefined) eq += (p.size * (marks[m] - p.entry)) / WAD;
  return eq;
}

// ---------- shared ----------
export const status = { lastPoll: 0, seasons: 0, promoted: 0, ranked: 0, lastErr: "" };
const db = () => createClient(env.need("SUPABASE_URL"), env.need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
const encPos = (ps: Record<string, Pos>) => Object.fromEntries(Object.entries(ps).map(([m, p]) => [m, { size: p.size.toString(), entry: p.entry.toString() }]));
const decPos = (j: Record<string, { size: string; entry: string }>) => Object.fromEntries(Object.entries(j ?? {}).map(([m, p]) => [m, { size: BigInt(p.size), entry: BigInt(p.entry) }])) as Record<string, Pos>;

async function marks(): Promise<{ price: Record<string, bigint>; open: Record<string, boolean> }> {
  const price: Record<string, bigint> = {}, open: Record<string, boolean> = {};
  await Promise.all(MARKETS.map(async (m: number) => {
    const mk: any = await pub.readContract({ address: E, abi, functionName: "market", args: [BigInt(m)] });
    try {
      const [p, , o] = await pub.readContract({ address: FEED, abi, functionName: "latest", args: [mk.p.feedId] });
      price[m] = p; open[m] = o;
    } catch { /* no price yet */ }
  }));
  return { price, open };
}

async function currentSeason(d: ReturnType<typeof db>) {
  const { data } = await d.from("gym_seasons").select("id,ends_at").eq("status", "open").order("id", { ascending: false }).limit(1).maybeSingle();
  return data;
}

/** Verify an agent-signed action: fresh timestamp, signer == agent, signature never used before. */
async function verifyAction(action: Record<string, unknown>, signature: Hex) {
  const ts = Number(action.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60) throw new Error("stale or missing ts (must be within 60 s)");
  const digest = keccak256(toBytes(canonical(action)));
  const signer = await recoverMessageAddress({ message: { raw: digest }, signature });
  if (signer.toLowerCase() !== String(action.agent).toLowerCase()) throw new Error("signature is not from this agent");
  return keccak256(signature);
}

// ---------- MCP tool handlers ----------
export const gymTools = [
  { name: "gym_status", description: "Current paper season and your paper beam (equity, state, positions, fills).", inputSchema: { type: "object", properties: { agent: { type: "string" } } } },
  { name: "gym_join", description: "Join the current paper season. Sign canonical JSON of {action:'gym_join', agent, season, ts} (EIP-191 over its keccak).", inputSchema: { type: "object", properties: { agent: { type: "string" }, season: { type: "integer" }, ts: { type: "integer" }, signature: { type: "string" } }, required: ["agent", "season", "ts", "signature"] } },
  { name: "gym_order", description: "Paper order through the engine's beam rules at the live mark. Sign canonical JSON of {action:'gym_order', agent, season, market, size, ts}. size is a signed 18-decimal integer string.", inputSchema: { type: "object", properties: { agent: { type: "string" }, season: { type: "integer" }, market: { type: "integer" }, size: { type: "string" }, ts: { type: "integer" }, signature: { type: "string" } }, required: ["agent", "season", "market", "size", "ts", "signature"] } },
];

export async function gymHandle(name: string, a: any): Promise<unknown> {
  const d = db();
  const season = await currentSeason(d);
  if (name === "gym_status") {
    const out: any = { season };
    if (a.agent && season) {
      const { data } = await d.from("gym_entries").select("budget::text,lev_cap::text,state,realized::text,hwm::text,equity::text,positions,fills,promoted").eq("season", season.id).eq("agent", String(a.agent).toLowerCase()).maybeSingle();
      out.entry = data;
    }
    return out;
  }
  if (!season) throw new Error("no open season");
  if (Number(a.season) !== Number(season.id)) throw new Error(`current season is ${season.id}`);
  const agent = String(a.agent).toLowerCase();
  if (name === "gym_join") {
    await verifyAction({ action: "gym_join", agent: a.agent, season: a.season, ts: a.ts }, a.signature);
    const budget = 1000n * WAD;
    const { error } = await d.from("gym_entries").insert({ season: season.id, agent, budget: budget.toString(), lev_cap: (5n * WAD).toString(), hwm: budget.toString(), equity: budget.toString() });
    if (error && error.code !== "23505") throw new Error(error.message);
    return { joined: true, season: season.id, budget: budget.toString(), levCap: "5", softBps: 500, hardBps: 750, endsAt: season.ends_at };
  }
  if (name === "gym_order") {
    const sigHash = await verifyAction({ action: "gym_order", agent: a.agent, season: a.season, market: a.market, size: a.size, ts: a.ts }, a.signature);
    const m = Number(a.market);
    let size: bigint;
    try { size = BigInt(a.size); } catch { throw new Error("size must be an integer string (18 decimals)"); }
    if (size === 0n) throw new Error("size must be non-zero");
    if (!MARKETS.includes(m)) throw new Error(`unknown market ${a.market}`);
    const { data: en } = await d.from("gym_entries").select("budget::text,lev_cap::text,state,realized::text,positions,fills,finished").eq("season", season.id).eq("agent", agent).maybeSingle();
    if (!en || en.finished) throw new Error("join the season first");
    const [{ price, open }, paused] = await Promise.all([marks(), pub.readContract({ address: E, abi, functionName: "opensPaused" })]);
    const mark = price[m];
    if (mark === undefined) throw new Error("no mark for this market");
    const ps = decPos(en.positions);
    const gross = Object.entries(ps).reduce((g, [k, p]) => g + (absB(p.size) * (price[k] ?? p.entry)) / WAD, 0n);
    const verdict = checkBeamOrder({
      beam: { state: en.state as BeamState, until: Math.floor(new Date(season.ends_at).getTime() / 1000), marketMask: ALL_MASK, budget: BigInt(en.budget), levCap: BigInt(en.lev_cap), gross, pending: 0n },
      market: m, currentSize: ps[m]?.size ?? 0n, size, mark, marketOpen: open[m] ?? false, opensPaused: paused, now: Math.floor(Date.now() / 1000),
    });
    // Record first: the unique sig_hash makes the signed order single-use even under concurrent calls.
    const { error: oe } = await d.from("gym_orders").insert({ sig_hash: sigHash, season: season.id, agent, market: m, size: size.toString(), price: mark.toString(), result: verdict.ok ? "filled" : verdict.reason });
    if (oe) throw new Error(oe.code === "23505" ? "this signed order was already used" : oe.message);
    if (!verdict.ok) return verdict;
    const { pos, realized } = paperFill(ps[m], size, mark);
    if (pos) ps[m] = pos; else delete ps[m];
    const newRealized = BigInt(en.realized) + realized;
    // Optimistic concurrency on the fill count: a concurrent order for the same agent retries.
    const { data: upd, error: ue } = await d.from("gym_entries").update({ positions: encPos(ps), realized: newRealized.toString(), fills: en.fills + 1 })
      .eq("season", season.id).eq("agent", agent).eq("fills", en.fills).select("fills");
    if (ue) throw new Error(ue.message);
    if (!upd?.length) throw new Error("concurrent order for this agent, retry with a new signature");
    await d.from("gym_orders").update({ fee: takerFee(size, mark, TAKER_BPS).toString() }).eq("sig_hash", sigHash);
    return { ok: true, filled: size.toString(), price: mark.toString(), realized: newRealized.toString() };
  }
  throw new Error(`unknown tool ${name}`);
}

// ---------- worker loop ----------
async function tickSeasons(d: ReturnType<typeof db>, minutes: number) {
  if (!(await currentSeason(d))) {
    const { data } = await d.from("gym_seasons").insert({ ends_at: new Date(Date.now() + minutes * 60_000).toISOString() }).select("id,ends_at").single();
    console.log(`[gym] season ${data!.id} open until ${data!.ends_at}`);
  }
  const { data: open } = await d.from("gym_seasons").select("id,ends_at").eq("status", "open");
  const { price } = await marks();
  for (const season of open ?? []) await tickSeason(d, season, price);
}

async function tickSeason(d: ReturnType<typeof db>, season: { id: number; ends_at: string }, price: Record<string, bigint>) {
  const { data: entries } = await d.from("gym_entries").select("agent,budget::text,soft_bps,hard_bps,state,realized::text,hwm::text,positions,fills").eq("season", season.id).eq("finished", false);
  const ended = Date.now() >= new Date(season.ends_at).getTime();
  for (const en of entries ?? []) {
    const eq = paperEquity(BigInt(en.budget), BigInt(en.realized), decPos(en.positions), price);
    let hwm = BigInt(en.hwm);
    const state = drawdownState(en.state as BeamState, eq, hwm, en.soft_bps, en.hard_bps);
    if (eq > hwm && state === en.state) hwm = eq;
    const patch: Record<string, unknown> = { equity: eq.toString(), hwm: hwm.toString(), state };
    if (ended) {
      patch.finished = true;
      // Promotion is a PAPER badge: inside the rules (not Cut) with MIN_FILLS fills of at least $50 notional each.
      // Spectrum's on-chain rank is separate and still needs real on-chain budget.
      // Numerics as text (JSON numbers lose precision; BigInt("1e+21") throws and would stick the season).
      const { data: fills } = await d.from("gym_orders").select("size::text,price::text").eq("season", season.id).eq("agent", en.agent).eq("result", "filled");
      const real = (fills ?? []).filter((f) => {
        try { return (absB(BigInt(f.size)) * BigInt(f.price)) / WAD >= MIN_FILL_NOTIONAL; } catch { return false; }
      }).length;
      patch.promoted = state !== "Cut" && real >= MIN_FILLS;
      if (patch.promoted) status.promoted++;
      const { data: sp } = await d.from("spectrum").select("paper_seasons").eq("agent", en.agent).maybeSingle();
      // `promoted` reflects the latest finished season, not a badge that sticks forever.
      if (sp) await d.from("spectrum").update({ paper_seasons: sp.paper_seasons + 1, promoted: patch.promoted }).eq("agent", en.agent);
    }
    await d.from("gym_entries").update(patch).eq("season", season.id).eq("agent", en.agent);
  }
  if (ended) {
    await d.from("gym_seasons").update({ status: "finished" }).eq("id", season.id);
    status.seasons++;
    console.log(`[gym] season ${season.id} finished: ${entries?.length ?? 0} entries`);
  }
}

/** Spectrum ranks from on-chain beams only: PnL on real budgets, minus a drawdown penalty. */
async function rankSpectrum(d: ReturnType<typeof db>) {
  const { data: listed } = await d.from("spectrum").select("agent").eq("active", true);
  for (const { agent } of listed ?? []) {
    const { data: bs } = await d.from("beams").select("crystal,beam,budget::text").eq("agent", agent);
    let budget = 0n, pnl = 0n, maxDd = 0;
    for (const b of bs ?? []) {
      const eq = await pub.readContract({ address: E, abi, functionName: "beamEquity", args: [BigInt(b.crystal), BigInt(b.beam)] });
      budget += BigInt(b.budget);
      pnl += eq - BigInt(b.budget);
      const { data: snaps } = await d.from("beam_eq").select("equity::text,hwm::text").eq("crystal", b.crystal).eq("beam", b.beam).order("ts", { ascending: false }).limit(2000);
      for (const s of snaps ?? []) {
        const h = BigInt(s.hwm);
        if (h > 0n) maxDd = Math.max(maxDd, Number(((h - BigInt(s.equity)) * 10_000n) / h));
      }
    }
    const score = budget >= MIN_RANK_BUDGET ? Number((pnl * 10_000n) / budget) - maxDd / 2 : null;
    await d.from("spectrum").update({ beams: bs?.length ?? 0, total_budget: budget.toString(), total_pnl: pnl.toString(), max_dd_bps: maxDd, rank_score: score, updated_at: new Date().toISOString() }).eq("agent", agent);
    status.ranked++;
  }
}

export async function startGym() {
  const minutes = Number(env.get("GYM_SEASON_MINUTES") ?? 1440);
  const d = db();
  console.log(`[gym] paper seasons of ${minutes} min; promotion needs >= ${MIN_FILLS} fills and no Cut`);
  for (;;) {
    try {
      await tickSeasons(d, minutes);
      await rankSpectrum(d);
      status.lastPoll = Date.now();
    } catch (e) {
      status.lastErr = scrub(e);
      console.error(`[gym] ${status.lastErr}`);
    }
    await Bun.sleep(30_000);
  }
}
