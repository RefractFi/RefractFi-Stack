// report-pusher, testnet fallback mode.
// Builds Data Streams-shaped reports from public prices (v3 for crypto, v8 with market status for equities), signs
// them with the pusher key (checked on-chain by TestnetVerifier) and pushes them to StreamsFeed on 5 s boundaries:
// a freshness push every PUSH_FRESH_EVERY seconds plus the exact close of any window that has queued orders.
import {
  createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseAbi, parseSignature,
  parseUnits, toHex, type Hex,
} from "viem";
import { type PrivateKeyAccount } from "viem/accounts";
import { chain, deploy, env, pk } from "./config";
import { keyAccount, sendOrReset } from "./chain";

const feedAbi = parseAbi(["function push(bytes[] fullReports)"]);
const WAD = 10n ** 18n;

/** Per price source: last time it was asked and last time it answered. alerts.ts turns long gaps into an alarm. */
export const sourceHealth: Record<string, { tried: number; ok: number }> = {};
async function track<T>(name: string, p: () => Promise<T>): Promise<T> {
  const h = (sourceHealth[name] ??= { tried: 0, ok: Date.now() }); // a new source gets the benefit of the doubt
  h.tried = Date.now();
  const v = await p();
  h.ok = Date.now();
  return v;
}
/** Sources asked within the last `downMs` that haven't answered for `downMs`. */
export const downSources = (health: typeof sourceHealth, now: number, downMs: number) =>
  Object.entries(health).filter(([, h]) => now - h.tried < downMs && now - h.ok >= downMs).map(([n, h]) => ({ name: n, mins: Math.round((now - h.ok) / 60_000) }));

type Source = (asset: "BTC" | "ETH") => Promise<string>;
const sources: Record<string, Source> = {
  coinbase: async (a) => (await getJson(`https://api.coinbase.com/v2/prices/${a}-USD/spot`)).data.amount,
  kraken: async (a) => {
    const pair = a === "BTC" ? "XBTUSD" : "ETHUSD";
    const r = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    return (Object.values(r.result)[0] as { c: string[] }).c[0];
  },
  bitstamp: async (a) => (await getJson(`https://www.bitstamp.net/api/v2/ticker/${a.toLowerCase()}usd/`)).last,
};

// Nasdaq hangs on requests without a browser User-Agent; Yahoo is fine either way.
const BROWSER = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", accept: "application/json, text/plain, */*" };

async function getJson(url: string, timeoutMs = 1500, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

/** Median of the quotes in WAD. Needs >= 2 quotes within 1% of each other, else null (no push beats a bad push). */
export function agreeMedian(quotes: bigint[]): bigint | null {
  if (quotes.length < 2) return null;
  const s = [...quotes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2n;
  if ((s[s.length - 1] - s[0]) * 100n > mid) return null;
  return mid;
}

export async function quote(asset: "BTC" | "ETH"): Promise<bigint | null> {
  const got = await Promise.allSettled(Object.entries(sources).map(([n, f]) => track(n, () => f(asset))));
  const q = got.flatMap((g) => (g.status === "fulfilled" ? [parseUnits(String(g.value), 18)] : []));
  return agreeMedian(q);
}

// ---------- equities (v8) ----------
export type Equity = "NVDA" | "TSLA" | "SPY";
const yahoo = async (s: Equity) => (await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=1d`, 4000, BROWSER)).chart.result[0].meta.regularMarketPrice;
const nasdaq = async (s: Equity) => {
  const r = await getJson(`https://api.nasdaq.com/api/quote/${s}/info?assetclass=${s === "SPY" ? "etf" : "stocks"}`, 4000, BROWSER);
  return String(r.data.primaryData.lastSalePrice).replace(/[$,]/g, "");
};

/** US regular session, Mon-Fri 09:30-16:00 New York time.
 *  ponytail: ignores exchange holidays and half days; read the v8 market status from Data Streams in M11. */
export function usMarketOpen(d: Date): boolean {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const mins = Number(p.hour) * 60 + Number(p.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** Open: median of Yahoo + Nasdaq (must agree within 1%). Closed: the official regular-session close (held price). */
export async function quoteEquity(s: Equity, open: boolean): Promise<bigint | null> {
  if (!open) {
    try { return parseUnits(String(await track("yahoo", () => yahoo(s))), 18); } catch { return null; }
  }
  const got = await Promise.allSettled([track("yahoo", () => yahoo(s)), track("nasdaq", () => nasdaq(s))]);
  return agreeMedian(got.flatMap((g) => (g.status === "fulfilled" ? [parseUnits(String(g.value), 18)] : [])));
}

/** v8 report data (RWA, with market status: 2 open, 1 closed), field order as StreamsFeed decodes it. */
export function v8Report(feedId: Hex, obs: number, price: bigint, open: boolean): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint32" }, { type: "uint32" }, { type: "uint192" }, { type: "uint192" },
      { type: "uint32" }, { type: "uint64" }, { type: "int192" }, { type: "uint32" },
    ],
    [feedId, obs, obs, 0n, 0n, obs + 60, BigInt(obs), price, open ? 2 : 1],
  );
}

/** v3 report data, field order as StreamsFeed decodes it. */
export function v3Report(feedId: Hex, obs: number, price: bigint): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint32" }, { type: "uint32" }, { type: "uint192" }, { type: "uint192" },
      { type: "uint32" }, { type: "int192" }, { type: "int192" }, { type: "int192" },
    ],
    [feedId, obs, obs, 0n, 0n, obs + 60, price, price, price],
  );
}

/** Full report payload as the verifier proxy expects it, signed EIP-191 over keccak256(reportData). */
export async function signReport(account: PrivateKeyAccount, reportData: Hex): Promise<Hex> {
  const sig = parseSignature(await account.signMessage({ message: { raw: keccak256(reportData) } }));
  const zero = pad("0x00");
  return encodeAbiParameters(
    [{ type: "bytes32[3]" }, { type: "bytes" }, { type: "bytes32[]" }, { type: "bytes32[]" }, { type: "bytes32" }],
    [[zero, zero, zero], reportData, [sig.r], [sig.s], pad(toHex(sig.v ?? 27n + BigInt(sig.yParity)))],
  );
}

export const status = { lastOk: 0, lastBoundary: 0, lastTx: "", lastErr: "", pushed: 0, closes: 0, skipped: 0, missed: 0 };

const WINDOW = 5;

/**
 * Which 5 s boundaries to put on-chain at boundary `b`.
 * - a freshness push every `freshEvery` seconds (markets refuse opens on prices older than maxAge = 30 s);
 * - the exact close of any window that has queued orders (settlement needs priceAt(close)), including closes
 *   from the previous window in case its orders were mined late.
 */
export function toPush(b: number, lastFresh: number, freshEvery: number, closesWithOrders: number[], pushed: Set<number>): number[] {
  const out = new Set<number>();
  if (b - lastFresh >= freshEvery) out.add(b);
  for (const c of closesWithOrders) if (c <= b && c >= b - 2 * WINDOW && !pushed.has(c)) out.add(c);
  return [...out].sort((x, y) => x - y);
}

export async function startPusher() {
  const freshEvery = Number(env.get("PUSH_FRESH_EVERY") ?? 20);
  if (freshEvery % WINDOW !== 0 || freshEvery >= 30) throw new Error("PUSH_FRESH_EVERY must be a multiple of 5 below the 30 s maxAge");
  const account = keyAccount(pk("PUSHER_PK"));
  const pub = createPublicClient({ chain, transport: http() });
  const wallet = createWalletClient({ chain, account, transport: http() });
  const feed = deploy.contracts.StreamsFeed.address as Hex;
  const engine = deploy.contracts.RefractEngine.address as Hex;
  const queuedAbi = parseAbi(["event Queued(uint256 indexed market, uint64 indexed window, uint256 crystal, uint256 beam, int256 size)"]);
  const feeds = { BTC: deploy.feeds["BTC/USD"] as Hex, ETH: deploy.feeds["ETH/USD"] as Hex };
  const eqFeeds = Object.fromEntries((["NVDA", "TSLA", "SPY"] as Equity[]).flatMap((s) => {
    const id = (deploy.feeds as Record<string, string>)[`${s}/USD`];
    return id ? [[s, id as Hex]] : [];
  })) as Partial<Record<Equity, Hex>>;
  // Equity quotes are cached (15 s while open, 10 min while closed) to stay polite to the free quote APIs.
  const eqCache = new Map<Equity, { price: bigint; open: boolean; at: number }>();

  const block = await pub.getBlock();
  const drift = Date.now() / 1000 - Number(block.timestamp);
  console.log(`[pusher] ${account.address} quotes every ${WINDOW}s, fresh push every ${freshEvery}s + closes with orders, drift ${drift.toFixed(1)}s`);
  if (Math.abs(drift) > 3) console.warn("[pusher] clock drift > 3s: window-close prices may land late");

  type Q = Partial<Record<"BTC" | "ETH", bigint>> & { eq?: Partial<Record<Equity, { price: bigint; open: boolean }>> };
  const quotes = new Map<number, Q>(); // boundary -> quotes (last ~2 min)
  const pushed = new Set<number>();
  let lastFresh = 0;

  // Each boundary runs on its own: a slow confirmation must never delay or skip the next close.
  let prev = 0;
  for (;;) {
    const b = Math.ceil(Date.now() / 1000 / WINDOW) * WINDOW;
    await Bun.sleep(Math.max(0, b * 1000 - Date.now() + 250));
    if (prev && b > prev + WINDOW) {
      status.missed += (b - prev) / WINDOW - 1;
      console.warn(`[pusher] missed boundaries ${prev + WINDOW}..${b - WINDOW}`);
    }
    prev = b;
    void tick(b);
  }

  async function tick(b: number) {
    try {
      const q: Q = { eq: {} };
      for (const asset of ["BTC", "ETH"] as const) {
        // One quick retry: a blip on the price APIs shouldn't cost a window its close price.
        const p = (await quote(asset)) ?? (await Bun.sleep(700), await quote(asset));
        if (p === null) { status.skipped++; console.warn(`[pusher] ${asset} @${b}: sources disagree or down, skipped`); continue; }
        q[asset] = p;
      }
      const open = usMarketOpen(new Date(b * 1000));
      const stale = (Object.keys(eqFeeds) as Equity[]).filter((s) => {
        const c = eqCache.get(s);
        return !c || c.open !== open || Date.now() - c.at > (open ? 15_000 : 600_000);
      });
      const fetched = await Promise.all(stale.map((s) => quoteEquity(s, open)));
      stale.forEach((s, i) => {
        const p = fetched[i];
        if (p !== null) eqCache.set(s, { price: p, open, at: Date.now() });
        else console.warn(`[pusher] ${s} @${b}: no agreeing quote${eqCache.get(s)?.open === open ? ", reusing last" : ", skipped"}`);
      });
      for (const s of Object.keys(eqFeeds) as Equity[]) {
        const cur = eqCache.get(s);
        if (cur && cur.open === open) q.eq![s] = { price: cur.price, open: cur.open }; // never push a stale status
      }
      quotes.set(b, q);
      for (const k of quotes.keys()) if (k < b - 120) quotes.delete(k);
      for (const k of pushed) if (k < b - 120) pushed.delete(k);

      // Windows that closed at b or b-5 and have orders need their exact close price on-chain.
      const w = BigInt(b / WINDOW) - 1n;
      const latest = await pub.getBlockNumber();
      const logs = await pub.getContractEvents({
        address: engine, abi: queuedAbi, eventName: "Queued", args: { window: [w, w - 1n] }, fromBlock: latest - 400n,
      });
      const closes = [...new Set(logs.map((l) => (Number(l.args.window!) + 1) * WINDOW))];

      const due = toPush(b, lastFresh, freshEvery, closes, pushed);
      const reports: Hex[] = [];
      for (const ts of due) {
        for (const [asset, id] of Object.entries(feeds) as ["BTC" | "ETH", Hex][]) {
          const p = quotes.get(ts)?.[asset];
          if (p !== undefined) reports.push(await signReport(account, v3Report(id, ts, p)));
        }
        for (const [s, id] of Object.entries(eqFeeds) as [Equity, Hex][]) {
          const e = quotes.get(ts)?.eq?.[s];
          if (!e) continue;
          // Every freshness push and every close, open or closed: the engine age-checks the mark for any trade,
          // reductions included, so a closed market needs a fresh (held) price too, like real v8 streams publish.
          if (ts !== b && !closes.includes(ts)) continue;
          reports.push(await signReport(account, v8Report(id, ts, e.price, e.open)));
        }
      }
      if (!reports.length) return;
      const hash = await sendOrReset(account.address, () => wallet.writeContract({ address: feed, abi: feedAbi, functionName: "push", args: [reports] }));
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (r.status !== "success") throw new Error(`push reverted ${hash}`);
      for (const ts of due) pushed.add(ts);
      if (due.includes(b)) lastFresh = b;
      status.closes += closes.filter((c) => due.includes(c)).length;
      Object.assign(status, { lastOk: Date.now(), lastBoundary: b, lastTx: hash, lastErr: "" });
      if (++status.pushed % 12 === 1 || closes.length) console.log(`[pusher] @${b} pushed ${due.join(",")} ${hash} gas ${r.gasUsed} (pushes ${status.pushed}, closes ${status.closes})`);
    } catch (e) {
      status.lastErr = String(e).replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);
      console.error(`[pusher] @${b} failed: ${status.lastErr}`);
    }
  }
}

export { WAD };
