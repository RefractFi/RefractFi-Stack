// Soak check (plan Verification #4) over [from, now]:
//  1. price freshness: BTC/USD Pushed events on-chain, share of time the price was within maxAge (30 s), worst gap;
//  2. windows: every window with Queued orders, closed > grace + 60 s ago, was settled or voided (WindowSettled).
// Usage: bun --env-file=../.env src/check-soak.ts <fromUnixSeconds>
import { createClient } from "@supabase/supabase-js";
import { parseAbiItem, type Hex } from "viem";
import { deploy, env } from "./config";
import { pub } from "./chain";

const MAX_AGE = 30, WINDOW = 5, GRACE = 120, CHUNK = 5000n;

/** Fraction of [from, to] covered by a price at most MAX_AGE old, and the longest gap between pushes. */
export function freshness(times: number[], from: number, to: number) {
  let stale = 0, worst = 0, prev = from - MAX_AGE; // assume fresh at the start; a gap at the start still counts below
  for (const t of [...times.filter((x) => x >= from && x <= to).sort((a, b) => a - b), to + MAX_AGE]) {
    worst = Math.max(worst, t - prev);
    if (t - prev > MAX_AGE) stale += t - prev - MAX_AGE;
    prev = t;
  }
  return { fresh: 1 - stale / Math.max(1, to - from), worst };
}

if (import.meta.main) {
  const from = Number(process.argv[2]);
  if (!from) throw new Error("usage: bun src/check-soak.ts <fromUnixSeconds>");
  const now = Math.floor(Date.now() / 1000);
  // First block at or after `from` (binary search on timestamps).
  let lo = 0n, hi = await pub.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (Number((await pub.getBlock({ blockNumber: mid })).timestamp) < from) lo = mid + 1n; else hi = mid;
  }
  const head = await pub.getBlockNumber();
  const event = parseAbiItem("event Pushed(bytes32 indexed feedId, int192 price, uint32 observedAt, uint32 status)");
  const times: number[] = [];
  for (let b = lo; b <= head; b += CHUNK) {
    const logs = await pub.getLogs({ address: deploy.contracts.StreamsFeed.address as Hex, event, args: { feedId: deploy.feeds["BTC/USD"] as Hex }, fromBlock: b, toBlock: b + CHUNK - 1n > head ? head : b + CHUNK - 1n });
    times.push(...logs.map((l) => Number(l.args.observedAt)));
  }
  const f = freshness(times, from, now);
  const hours = ((now - from) / 3600).toFixed(1);
  console.log(`${f.fresh >= 0.99 ? "PASS" : "FAIL"} prices fresh ${(f.fresh * 100).toFixed(2)}% of ${hours} h (${times.length} BTC pushes, worst gap ${f.worst} s)`);

  const db = createClient(env.need("SUPABASE_URL"), env.need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
  const since = new Date(from * 1000).toISOString();
  const rows = async (name: string) => {
    const out: any[] = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await db.from("events").select("market,args->>window").eq("name", name).gte("block_time", since).range(i, i + 999);
      if (error) throw new Error(error.message);
      out.push(...data);
      if (data.length < 1000) return out;
    }
  };
  const settled = new Set((await rows("WindowSettled")).map((r) => `${r.market}:${r.window}`));
  const due = [...new Set((await rows("Queued")).filter((r) => (Number(r.window) + 1) * WINDOW + GRACE + 60 < now).map((r) => `${r.market}:${r.window}`))];
  const stuck = due.filter((k) => !settled.has(k));
  console.log(`${stuck.length ? "FAIL" : "PASS"} windows with orders settled or voided: ${due.length - stuck.length}/${due.length}${stuck.length ? `, stuck ${stuck.slice(0, 5).join(" ")}` : ""}`);
}
