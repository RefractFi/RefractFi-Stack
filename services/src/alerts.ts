// alerts: owner notifications from the indexed events (PDF §7): beam Halved or Cut, liquidation, crossing orders
// dropped at settlement (or voided), and margin within 20% of maintenance. Writes `alerts` (shown live in the
// dashboard) and sends each to the owner's linked Telegram chat, if any.
import { createClient } from "@supabase/supabase-js";
import { formatEther, parseAbi, parseEther, type Hex } from "viem";
import { deploy, env } from "./config";
import { pub, scrub } from "./chain";
import { downSources, sourceHealth } from "./pusher";

const E = deploy.contracts.RefractEngine.address.toLowerCase() as Hex;
const CURSOR = `alerts:${E}`;
const MARGIN_EVERY_MS = 30_000;
const riskAbi = parseAbi(["function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)"]);

export const status = { lastPoll: 0, alerts: 0, sent: 0, lastErr: "", low: "", priceAge: 0 };

// Low-balance alarm for the operator's keeper wallets (deployments/testnet.json → accounts). The pusher burns
// ~0.011 ETH/day in US hours, so its floor leaves ~6 h to refill; the others only spend when they act.
const BALANCE_EVERY_MS = 10 * 60_000;
const BALANCE_REPEAT_MS = 6 * 3600_000;
const FLOORS: Record<string, bigint> = { pusher: parseEther("0.003") };
const DEFAULT_FLOOR = parseEther("0.0002");
// Stale-price alarm: the pusher can stall with gas in the tank (Nov 16-17: a nonce bug froze prices for 13 h unseen).
// BTC/USD is pushed every 20 s around the clock, so its age is the oracle's pulse.
const PRICE_EVERY_MS = 60_000;
const PRICE_STALE_S = 120;
const PRICE_REPEAT_MS = 3600_000;
const SOURCE_DOWN_MS = 10 * 60_000;
const SOURCE_REPEAT_MS = 6 * 3600_000;
const feedAbi = parseAbi(["function latest(bytes32 feedId) view returns (int256 price, uint64 observedAt, bool open)"]);
export const lowWallets = (bal: Record<string, bigint>) =>
  Object.entries(bal).filter(([role, b]) => b < (FLOORS[role] ?? DEFAULT_FLOOR)).map(([role]) => role);

async function telegram(token: string | undefined, chatId: string | number, text: string) {
  if (!token) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
  return r.ok;
}
type Alert = { owner: string; crystal: number; beam: number | null; kind: string; payload: object };

/** The engine's hard-stop test (enforce): equity <= hwm - hwm * hardBps / 10_000. */
export const isStopBreach = (equity: bigint, hwm: bigint, hardBps: number) => equity <= hwm - (hwm * BigInt(hardBps)) / 10_000n;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function message(a: Alert): string {
  const where = `Crystal #${a.crystal}${a.beam != null ? `, Beam ${a.beam + 1}` : ""}`;
  switch (a.kind) {
    case "halved": return `⚠️ ${where} hit its soft stop: its cap is halved. Reductions still work.`;
    case "cut": return `⛔ ${where} hit its hard stop and was cut: its positions are closed. Re-arm it from the dashboard if you want it trading again.`;
    case "liquidated": return `⛔ ${where} was liquidated: equity fell below maintenance margin and every position was closed.`;
    case "margin": return `⚠️ ${where} is within 20% of maintenance margin. Add collateral or reduce risk to avoid liquidation.`;
    case "dropped": return `ℹ️ ${where}: a crossing order was dropped when its window settled (rules changed or window voided).`;
    default: return `${where}: ${a.kind}`;
  }
}

export async function startAlerts() {
  const d = createClient(env.need("SUPABASE_URL"), env.need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
  const token = env.get("TELEGRAM_BOT_TOKEN");
  const owners = new Map<number, string>();
  const ownerOf = async (crystal: number) => {
    if (!owners.has(crystal)) {
      const { data } = await d.from("crystals").select("owner").eq("id", crystal).maybeSingle();
      if (data) owners.set(crystal, data.owner);
    }
    return owners.get(crystal);
  };

  const { data: cur } = await d.from("indexer_state").select("last_block").eq("id", CURSOR).maybeSingle();
  let cursor = cur?.last_block ?? deploy.contracts.RefractEngine.block - 1;
  let lastMargin = 0;
  const operator = env.get("OPERATOR_CHAT_ID");
  let lastBalance = 0, lastPrice = Date.now(), staleSince = 0, staleWarned = 0, priceFails = 0; // first price check after 60 s: let the pusher start
  const warned = new Map<string, number>(); // role -> last alarm time
  console.log(`[alerts] from block ${cursor + 1}, telegram ${token ? "on" : "off (TELEGRAM_BOT_TOKEN not set)"}, low-balance alarm ${operator ? "on" : "log only (OPERATOR_CHAT_ID not set)"}`);

  for (;;) {
    if (Date.now() - lastPrice > PRICE_EVERY_MS) {
      lastPrice = Date.now();
      const ops = (text: string) => (operator ? telegram(token, operator, text).catch(() => false) : Promise.resolve(false));
      let at: bigint | null = null;
      try {
        [, at] = await pub.readContract({ address: deploy.contracts.StreamsFeed.address as Hex, abi: feedAbi, functionName: "latest", args: [deploy.feeds["BTC/USD"] as Hex] });
        priceFails = 0;
      } catch (e) {
        console.error(`[alerts] price check: ${scrub(e)}`);
        priceFails++;
      }
      // Unreadable counts as stale: age is unknown, so report "unreadable for N min" instead of a number.
      status.priceAge = at === null ? -1 : Math.floor(Date.now() / 1000) - Number(at);
      const stale = at === null ? priceFails >= 5 : status.priceAge > PRICE_STALE_S;
      if (stale) {
        staleSince ||= Date.now();
        if (Date.now() - staleWarned > PRICE_REPEAT_MS) {
          staleWarned = Date.now();
          const why = at === null ? `the worker can't read the price feed (${priceFails} min; RPC down?)` : `BTC/USD last pushed ${Math.round(status.priceAge / 60)} min ago`;
          console.warn(`[alerts] prices stale: ${why}`);
          await ops(`🛑 RefractFi testnet: prices are stale: ${why}. Opens fail with StalePrice. Check the pusher in the Railway logs (gas, nonce, quote sources, RPC).`);
        }
      } else if (staleSince && at !== null) {
        await ops(`✅ RefractFi testnet: prices are flowing again (were stale for ${Math.round((Date.now() - staleSince) / 60_000)} min).`);
        staleSince = staleWarned = 0;
      }
    }
    // Price sources (Coinbase, Kraken, Bitstamp, Yahoo, Nasdaq): one that's been failing for 10 min gets an alarm,
    // so it can be replaced. Crypto needs 2 of 3 agreeing; open-market equities need both Yahoo and Nasdaq.
    for (const d of downSources(sourceHealth, Date.now(), SOURCE_DOWN_MS)) {
      if (Date.now() - (warned.get(`src:${d.name}`) ?? 0) < SOURCE_REPEAT_MS) continue;
      warned.set(`src:${d.name}`, Date.now());
      console.warn(`[alerts] price source down: ${d.name} (${d.mins} min)`);
      const hit = d.name === "yahoo" || d.name === "nasdaq" ? "NVDA/TSLA/SPY prices stop while the US market is open" : "BTC/ETH still price from the other two, but one more failure stops them";
      if (operator) await telegram(token, operator, `📉 RefractFi oracle: price source ${d.name} has been failing for ${d.mins} min. ${hit}. Time to find a replacement source.`).catch(() => false);
    }
    for (const k of warned.keys()) if (k.startsWith("src:") && !downSources(sourceHealth, Date.now(), SOURCE_DOWN_MS).some((d) => `src:${d.name}` === k)) {
      warned.delete(k);
      if (operator) await telegram(token, operator, `✅ RefractFi oracle: price source ${k.slice(4)} is answering again.`).catch(() => false);
    }
    if (Date.now() - lastBalance > BALANCE_EVERY_MS) {
      lastBalance = Date.now();
      try {
        const roles = Object.entries(deploy.accounts) as [string, Hex][];
        const bal = Object.fromEntries(await Promise.all(roles.map(async ([r, a]) => [r, await pub.getBalance({ address: a })] as const)));
        const low = lowWallets(bal);
        status.low = low.map((r) => `${r} ${formatEther(bal[r])} ETH`).join("; ");
        for (const r of low) {
          if (Date.now() - (warned.get(r) ?? 0) < BALANCE_REPEAT_MS) continue;
          warned.set(r, Date.now());
          console.warn(`[alerts] low balance: ${r} ${formatEther(bal[r])} ETH`);
          if (operator) await telegram(token, operator, `⛽ RefractFi testnet: the ${r} wallet is low on gas (${formatEther(bal[r])} ETH). Send faucet ETH to the deployer ${deploy.accounts.deployer} and spread it.`);
        }
        for (const r of warned.keys()) if (!r.startsWith("src:") && !low.includes(r)) warned.delete(r); // refilled: alarm again next time it drops
      } catch (e) { console.error(`[alerts] balance check: ${scrub(e)}`); }
    }
    try {
      const out: Alert[] = [];
      // Only read up to what the indexer has fully committed, so no event can land behind the cursor.
      const { data: idx } = await d.from("indexer_state").select("last_block").eq("id", `engine:${E}`).maybeSingle();
      const upTo = idx?.last_block ?? cursor;
      if (upTo > cursor) {
        const { data: evs, error } = await d.from("events").select("tx_hash,name,crystal,beam,market,args")
          .gt("block_number", cursor).lte("block_number", upTo).in("name", ["BeamState_", "Flattened", "WindowSettled"])
          .order("block_number").order("log_index");
        if (error) throw new Error(error.message);
        for (const e of evs ?? []) {
          if (e.name === "BeamState_" && (e.args.state === 2 || e.args.state === 3)) {
            const owner = await ownerOf(e.crystal);
            if (!owner) continue;
            // Halved always alerts. A Cut is classified from event data only (never calldata or tx sender):
            //  - skipped if the same tx flattened THIS crystal (owner flatten, or a liquidation with its own alert);
            //  - otherwise it alerts when the cut-time equity was at or below the hard-stop line, i.e. a stop breach,
            //    whoever called it. A voluntary owner cut above the line doesn't alert. Unknown params still alert.
            if (e.args.state === 3) {
              const { data: fl } = await d.from("events").select("name").eq("tx_hash", e.tx_hash).eq("name", "Flattened").eq("crystal", e.crystal).limit(1);
              if (fl?.length) continue;
              const { data: bm } = await d.from("beams").select("hard_bps").eq("crystal", e.crystal).eq("beam", e.beam).maybeSingle();
              if (bm && !isStopBreach(BigInt(e.args.equity), BigInt(e.args.hwm), bm.hard_bps)) continue;
            }
            out.push({ owner, crystal: e.crystal, beam: e.beam, kind: e.args.state === 2 ? "halved" : "cut", payload: { tx: e.tx_hash, equity: e.args.equity, hwm: e.args.hwm } });
          } else if (e.name === "Flattened" && e.args.liquidation) {
            const owner = await ownerOf(e.crystal);
            if (owner) out.push({ owner, crystal: e.crystal, beam: null, kind: "liquidated", payload: { tx: e.tx_hash, fee: e.args.fee } });
          } else if (e.name === "WindowSettled") {
            // Orders queued in this window that got no fill in the settle tx were dropped (or the window was voided).
            const { data: queued } = await d.from("events").select("crystal,beam").eq("name", "Queued").eq("market", e.market).eq("args->>window", String(e.args.window));
            const { data: filled } = await d.from("events").select("crystal,beam").eq("name", "Filled").eq("tx_hash", e.tx_hash);
            const got = new Set((filled ?? []).map((f) => `${f.crystal}:${f.beam}`));
            for (const q of queued ?? []) {
              if (got.has(`${q.crystal}:${q.beam}`)) continue;
              const owner = await ownerOf(q.crystal);
              if (owner) out.push({ owner, crystal: q.crystal, beam: q.beam, kind: "dropped", payload: { market: e.market, window: e.args.window, voided: String(e.args.mark) === "0", tx: e.tx_hash } });
            }
          }
        }
        cursor = upTo;
      }

      if (Date.now() - lastMargin > MARGIN_EVERY_MS) {
        lastMargin = Date.now();
        const { data: open } = await d.from("crystals").select("id,owner").neq("open_mask", 0);
        const since = new Date(Date.now() - 3600_000).toISOString();
        for (const c of open ?? []) {
          const [equity, , mm] = await pub.readContract({ address: E, abi: riskAbi, functionName: "crystalRisk", args: [BigInt(c.id)] });
          if (mm === 0n || equity * 10n >= mm * 12n) continue; // fine while equity >= 1.2 × maintenance
          const { data: recent } = await d.from("alerts").select("id").eq("kind", "margin").eq("crystal", c.id).gt("ts", since).limit(1);
          if (!recent?.length) out.push({ owner: c.owner, crystal: c.id, beam: null, kind: "margin", payload: { equity: equity.toString(), mm: mm.toString() } });
        }
      }

      if (out.length) {
        const { error } = await d.from("alerts").insert(out);
        if (error) throw new Error(error.message);
        status.alerts += out.length;
        console.log(`[alerts] ${out.map((a) => `${a.kind} #${a.crystal}`).join(", ")}`);
      }
      await d.from("indexer_state").upsert({ id: CURSOR, last_block: cursor, updated_at: new Date().toISOString() });

      // Telegram delivery: every unsent alert is attempted once; sent_tg marks it handled either way.
      const { data: unsent } = await d.from("alerts").select("id,owner,crystal,beam,kind,payload").eq("sent_tg", false).order("id").limit(50);
      for (const a of unsent ?? []) {
        if (token) {
          const { data: link } = await d.from("telegram_links").select("chat_id").eq("owner", a.owner).maybeSingle();
          if (link && await telegram(token, link.chat_id, `${message(a as Alert)}\nWallet ${short(a.owner)} · refractfi.org/dashboard?view=activity`)) status.sent++;
        }
        await d.from("alerts").update({ sent_tg: true }).eq("id", a.id);
      }
      status.lastPoll = Date.now();
    } catch (e) {
      status.lastErr = scrub(e);
      console.error(`[alerts] ${status.lastErr}`);
    }
    await Bun.sleep(5000);
  }
}
