// Spot check: every crystal and beam row in Supabase equals the engine's current state, field by field.
// Usage: bun --env-file=../.env src/check-index.ts
import { createClient } from "@supabase/supabase-js";
import { parseAbi } from "viem";
import { env } from "./config";
import { engine, pub } from "./chain";

const abi = parseAbi([
  "function crystalCount() view returns (uint256)",
  "function crystals(uint256) view returns (address owner, uint8 beamCount, uint32 openMask, int256 collateral, int256 netDeposits, int256 perfPaid, int256 liqPaid, int256 badDebt, int256 pending)",
  "function beam(uint256 pid, uint256 bid) view returns (((address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap) p, uint8 state, uint32 openMask, int256 realized, int256 hwm, int256 feeHwm, uint64 lastCrystal, int256 pending))",
]);
const STATES = ["None", "Active", "Halved", "Cut"];
const db = createClient(env.need("SUPABASE_URL"), env.need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
const r = (fn: string, args: unknown[] = []) => pub.readContract({ address: engine, abi, functionName: fn as never, args: args as never }) as Promise<any>;

const bad: string[] = [];
const eq = (what: string, chain: unknown, row: unknown) => { if (String(chain) !== String(row)) bad.push(`${what}: chain ${chain} db ${row}`); };

const n: bigint = await r("crystalCount");
// numeric(78,0) must be read as text: PostgREST returns numerics as JSON numbers, which JS rounds past ~16 digits.
const { data: crystals } = await db.from("crystals").select("id,owner,open_mask,collateral::text,bad_debt::text");
const { data: beams } = await db.from("beams").select("crystal,beam,state,hwm::text,realized::text,budget::text");
eq("crystal count", n, crystals?.length);
let checkedBeams = 0;
for (let pid = 1n; pid <= n; pid++) {
  const c = await r("crystals", [pid]);
  const row = crystals?.find((x) => BigInt(x.id) === pid);
  if (!row) { bad.push(`crystal ${pid} missing`); continue; }
  eq(`c${pid}.owner`, c[0].toLowerCase(), row.owner);
  eq(`c${pid}.collateral`, c[3], row.collateral);
  eq(`c${pid}.open_mask`, c[2], row.open_mask);
  eq(`c${pid}.bad_debt`, c[7], row.bad_debt);
  for (let bid = 0n; bid < BigInt(c[1]); bid++) {
    const b = await r("beam", [pid, bid]);
    const br = beams?.find((x) => BigInt(x.crystal) === pid && BigInt(x.beam) === bid);
    if (!br) { bad.push(`beam ${pid}/${bid} missing`); continue; }
    eq(`b${pid}/${bid}.state`, STATES[b.state], br.state);
    eq(`b${pid}/${bid}.hwm`, b.hwm, br.hwm);
    eq(`b${pid}/${bid}.realized`, b.realized, br.realized);
    eq(`b${pid}/${bid}.budget`, b.p.budget, br.budget);
    checkedBeams++;
  }
}
console.log(`checked ${n} crystals, ${checkedBeams} beams: ${bad.length ? "MISMATCH" : "DB matches chain"}`);
for (const x of bad) console.log("  " + x);
if (bad.length) process.exit(1);
