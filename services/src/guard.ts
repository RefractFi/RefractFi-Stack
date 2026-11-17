// enforcer + liquidator. Every POLL_MS: simulate `liquidate` for crystals with an open net position, then `enforce`
// for live beams that hold virtual positions; send only what the engine would accept (simulation IS the engine's
// rule check, so there's no off-chain maths to drift from the contract).
//
// Design (settled after several review rounds; see docs/security/m7-review.md §5):
//  - Work set from the indexer (paged, freshness-checked), so empty crystals and beams cost nothing. If the indexer
//    is stale, behind on crystals, or unreachable, fall back to scanning the chain and report it.
//  - Liquidations: every candidate, every poll, in parallel batches, no time budget. A candidate needs an open NET
//    position, which needs real margin, so this set is costly to spam; errors are simply retried next poll.
//  - Stop checks: cover beams in hedged crystals too (flat net book, full virtual positions). Time budget plus a
//    guaranteed minimum per poll; the cursor always advances, and beams that error go to a small retry list checked
//    first next poll, so no single beam can pin the cursor or starve the rest.
//  - Soft consistency issues (work set capped, beam rows vs beam counts mid-update) are reported, not fatal.
import { createClient } from "@supabase/supabase-js";
import { engine, engineAbi, newStatus, pub, scrub, signer, simulateThenSend } from "./chain";
import { env } from "./config";

const POLL_MS = 5000;
const ENFORCE_BUDGET_MS = 6000;
const MIN_BEAMS_PER_POLL = 10;
const LIQ_BATCH = 8;
const MAX_RETRY = 50;
const MAX_RETRY_PER_POLL = 5;
const MAX_FAILS = 3; // a beam that keeps erroring leaves the retry list; the rotation still reaches it
const PAGE = 1000;
// ponytail: work sets above this are truncated (and reported); page by key range from the cursor if the testnet
// ever gets near it.
const MAX_WORK_ROWS = 20_000;
const MAX_INDEXER_LAG_BLOCKS = 100n; // ~25 s at ~4 blocks/s
const IGNORE = new Set(["NothingToEnforce", "BeamClosed", "NotLiquidatable"]);

export const status = { ...newStatus(), enforced: 0, liquidated: 0, crystals: 0, beams: 0, source: "", warnings: "" };

type Key = [bigint, bigint];
type WorkSet = { crystals: bigint[]; beams: Key[]; warnings: string[] };
const cmp = (a: Key, b: Key) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1);
const same = (a: Key, b: Key) => a[0] === b[0] && a[1] === b[1];

/** Beams in rotation order: everything after `last` first, then wrap around. `list` must be sorted. */
export function rotate(list: Key[], last: Key | null): Key[] {
  if (!last) return list;
  const i = list.findIndex((k) => cmp(k, last) > 0);
  return i < 0 ? list : [...list.slice(i), ...list.slice(0, i)];
}

/** This poll's stop-check order: up to MAX_RETRY_PER_POLL earlier failures first (still in the work set), then the
 *  rotation, so retries can never crowd out the guaranteed rotation work. */
export function enforceOrder(list: Key[], last: Key | null, retry: Key[]): Key[] {
  const again = retry.filter((r) => list.some((k) => same(k, r))).slice(0, MAX_RETRY_PER_POLL);
  return [...again, ...rotate(list, last).filter((k) => !again.some((r) => same(r, k)))];
}

/** Every row of a query, page by page (PostgREST caps a response at its max-rows). */
async function all(q: () => any, warnings: string[]): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
    if (rows.length >= MAX_WORK_ROWS) { warnings.push(`work set capped at ${MAX_WORK_ROWS} rows`); return rows; }
  }
}

async function fromIndexer(d: any): Promise<WorkSet> { // supabase-js client
  const warnings: string[] = [];
  const [head, n, idx, maxId] = await Promise.all([
    pub.getBlockNumber(),
    pub.readContract({ address: engine, abi: engineAbi, functionName: "crystalCount" }),
    d.from("indexer_state").select("last_block").eq("id", `engine:${engine.toLowerCase()}`).maybeSingle(),
    d.from("crystals").select("id").order("id", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const lag = head - BigInt(idx.data?.last_block ?? 0);
  if (lag < -10n || lag > MAX_INDEXER_LAG_BLOCKS) throw new Error(`indexer cursor ${lag} blocks from head`);
  if (BigInt(maxId.data?.id ?? 0) < n) throw new Error(`indexer has ${maxId.data?.id ?? 0} of ${n} crystals`);
  const [cs, bs, counts, beamRows] = await Promise.all([
    all(() => d.from("crystals").select("id").neq("open_mask", 0).order("id"), warnings),
    all(() => d.from("beams").select("crystal,beam").in("state", ["Active", "Halved"]).neq("open_mask", 0).order("crystal").order("beam"), warnings),
    all(() => d.from("crystals").select("beam_count").order("id"), warnings),
    d.from("beams").select("beam", { count: "exact", head: true }),
  ]);
  const expected = counts.reduce((s, c) => s + Number(c.beam_count), 0);
  if (beamRows.count !== expected) warnings.push(`indexer beam rows ${beamRows.count} vs crystal beam counts ${expected} (mid-update?)`);
  return { crystals: cs.map((x) => BigInt(x.id)), beams: bs.map((x) => [BigInt(x.crystal), BigInt(x.beam)] as Key), warnings };
}

async function fromChain(): Promise<WorkSet> {
  const n = await pub.readContract({ address: engine, abi: engineAbi, functionName: "crystalCount" });
  const out: WorkSet = { crystals: [], beams: [], warnings: [] };
  for (let pid = 1n; pid <= n; pid++) {
    const [, beamCount, openMask] = await pub.readContract({ address: engine, abi: engineAbi, functionName: "crystals", args: [pid] });
    if (openMask !== 0) out.crystals.push(pid);
    for (let bid = 0n; bid < BigInt(beamCount); bid++) out.beams.push([pid, bid]);
  }
  return out;
}

export async function startGuard() {
  const s = signer("KEEPER_PK");
  const url = env.get("SUPABASE_URL"), key = env.get("SUPABASE_SECRET_KEY");
  const d = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  console.log(`[guard] ${s.account.address} enforcer + liquidator on ${engine} (work set from ${d ? "indexer" : "chain scan"})`);
  let last: Key | null = null;
  let retry: Key[] = [];
  const fails = new Map<string, number>();
  for (;;) {
    try {
      let work: WorkSet;
      try {
        if (!d) throw new Error("no indexer configured");
        work = await fromIndexer(d);
        status.source = "indexer";
      } catch (e) {
        work = await fromChain();
        work.warnings.push(`work set from chain scan: ${scrub(e)}`);
        status.source = "chain";
      }
      status.crystals = work.crystals.length;
      status.beams = work.beams.length;
      status.warnings = work.warnings.join("; ");
      if (status.warnings) console.warn(`[guard] ${status.warnings}`);

      // 1. Every liquidation candidate, every poll, in parallel batches.
      const liquidated = new Set<bigint>();
      for (let i = 0; i < work.crystals.length; i += LIQ_BATCH) {
        await Promise.all(work.crystals.slice(i, i + LIQ_BATCH).map(async (pid) => {
          try {
            const liq = await simulateThenSend(s, "liquidate", [pid]);
            if ("hash" in liq) {
              liquidated.add(pid);
              status.liquidated++; status.sent++; status.lastTx = liq.hash!;
              console.log(`[guard] liquidated crystal ${pid} ${liq.hash}`);
            } else if (!IGNORE.has(liq.refused!)) console.warn(`[guard] liquidate ${pid} refused: ${liq.refused}`);
          } catch (e) { console.error(`[guard] liquidate ${pid}: ${scrub(e)}`); }
        }));
      }

      // 2. Stop checks: retries first, then the rotation; time budget with a guaranteed minimum.
      const deadline = Date.now() + ENFORCE_BUDGET_MS;
      const failed: Key[] = [];
      let checked = 0;
      for (const k of enforceOrder(work.beams, last, retry)) {
        if (checked >= MIN_BEAMS_PER_POLL && Date.now() > deadline) break;
        const [pid, bid] = k;
        if (!retry.some((r) => same(r, k))) last = k; // the rotation cursor always moves on
        if (liquidated.has(pid)) continue;
        checked++;
        try {
          const r = await simulateThenSend(s, "enforce", [pid, bid]);
          if ("hash" in r) {
            status.enforced++; status.sent++; status.lastTx = r.hash!;
            console.log(`[guard] enforced crystal ${pid} beam ${bid} ${r.hash}`);
          } else if (!IGNORE.has(r.refused!)) console.warn(`[guard] enforce ${pid}/${bid} refused: ${r.refused}`);
          fails.delete(`${pid}:${bid}`);
        } catch (e) {
          console.error(`[guard] enforce ${pid}/${bid}: ${scrub(e)}`);
          const n = (fails.get(`${pid}:${bid}`) ?? 0) + 1;
          fails.set(`${pid}:${bid}`, n);
          if (n < MAX_FAILS && failed.length < MAX_RETRY) failed.push(k);
          else fails.delete(`${pid}:${bid}`);
        }
      }
      retry = failed;
      status.lastPoll = Date.now();
    } catch (e) {
      status.lastErr = scrub(e);
      console.error(`[guard] ${status.lastErr}`);
    }
    await Bun.sleep(POLL_MS);
  }
}
