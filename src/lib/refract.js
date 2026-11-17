// RefractFi testnet client for the dashboard: chain reads/writes (viem + the user's wallet) and Supabase reads.
// Every write is simulated first, so a refusal surfaces as the engine's own error name before any signature.
import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, http, parseAbi, parseUnits, BaseError, ContractFunctionRevertedError } from 'viem';
import { createClient } from '@supabase/supabase-js';
import dep from '../../deployments/testnet.json';

export const deployment = dep;
export const CHAIN_ID = dep.chainId;
export const ENGINE = dep.contracts.RefractEngine.address;
export const USDG = dep.contracts.MockUSDG.address;
const FEED = dep.contracts.StreamsFeed.address;
export const MARKETS = dep.markets; // [{id, name}]

export const chain = defineChain({
  id: dep.chainId,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [dep.rpc] } },
  blockExplorers: { default: { name: 'Explorer', url: dep.explorer } },
});
export const pub = createPublicClient({ chain, transport: http() });
export const db = createClient(dep.supabase, dep.supabasePublishableKey, { auth: { persistSession: false } });

const BEAM_TUPLE = '(address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap)';
export const engineAbi = parseAbi([
  'function openCrystal() returns (uint256)',
  'function deposit(uint256 pid, uint256 amount)',
  'function withdraw(uint256 pid, uint256 amount)',
  `function setBeam(uint256 pid, uint256 bid, ${BEAM_TUPLE} p)`,
  'function cutBeam(uint256 pid, uint256 bid)',
  'function rearm(uint256 pid, uint256 bid)',
  'function flatten(uint256 pid)',
  'function lpDeposit(uint256 amount) returns (uint256)',
  'function lpWithdraw(uint256 shares) returns (uint256)',
  'function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)',
  'function grossMargin(uint256 pid) view returns (int256)',
  'function beamEquity(uint256 pid, uint256 bid) view returns (int256)',
  'function beamPosition(uint256 pid, uint256 bid, uint256 m) view returns ((int256 size, int256 last, int256 f0))',
  'function poolNav() view returns (int256)',
  'function lensReserve() view returns (int256)',
  'function totalShares() view returns (uint256)',
  'function sharesOf(address) view returns (uint256)',
  'function crystalCap() view returns (uint256)',
  'function lensCap() view returns (uint256)',
  'function market(uint256 m) view returns (((bytes32 feedId, int256 maxLev, int256 mmr, uint16 takerFeeBps, uint16 crossFeeBps, int256 skewScale, int256 maxFundingPerDay, int256 maxSkew, uint32 maxAge) p, bool listed, int256 skew, int256 sumSL, int256 sumSF, int256 fundingIndex, uint64 lastAccrual))',
  'event CrystalOpened(uint256 indexed crystal, address indexed owner)',
  'error NotAdmin()', 'error NotGuardian()', 'error NotOwner()', 'error NotAgent()', 'error BadParams()',
  'error BeamExpired()', 'error BeamClosed()', 'error MarketNotAllowed()', 'error OpensPaused()', 'error MarketClosed()',
  'error OverBeamCap()', 'error OverSkewCap()', 'error InsufficientMargin()', 'error Slippage()', 'error StalePrice()',
  'error WindowOpen()', 'error WindowFull()', 'error AlreadySettled()', 'error NotLiquidatable()', 'error MustCutFirst()',
  'error TooSoon()', 'error NothingToEnforce()', 'error OverCap()',
]);
const usdgAbi = parseAbi([
  'function mint(address to, uint256 amt)',
  'function approve(address s, uint256 amt) returns (bool)',
  'function allowance(address o, address s) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const feedAbi = parseAbi(['function latest(bytes32 feedId) view returns (int256 price, uint64 observedAt, bool open)']);

/** Plain-language reasons for the engine's errors. */
const REASONS = {
  OverCap: 'Over the testnet deposit cap ($50k per Crystal, $2M Lens).',
  InsufficientMargin: 'Not enough margin for that: the Crystal would fall below initial margin.',
  OverBeamCap: "Over this Beam's budget × leverage cap.",
  StalePrice: 'The latest price is older than 30 s; try again in a moment.',
  OpensPaused: 'New risk is paused by the guardian. Reductions and exits still work.',
  NotOwner: 'Only the Crystal owner can do this.',
  BadParams: 'The engine rejected these parameters (check stops, budget and beam order).',
  MustCutFirst: 'This Beam passed its hard stop: it has to be cut before anything else.',
};
export function errorText(e) {
  if (e?.code === 4001 || /rejected|denied/i.test(e?.message || '')) return 'Request cancelled in the wallet.';
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = r?.data?.errorName;
    if (name) return REASONS[name] || `The engine refused: ${name}.`;
    return e.shortMessage || e.message;
  }
  return e?.message || String(e);
}

export const fmt = (wad, dp = 2) => Number(formatUnits(BigInt(wad ?? 0), 18)).toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp });
export const fmtUsdg = (amt, dp = 2) => Number(formatUnits(BigInt(amt ?? 0), 6)).toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp });
export const usdg = (s) => parseUnits(String(s), 6);
export const wad = (s) => parseUnits(String(s), 18);
export const txUrl = (h) => `${dep.explorer}/tx/${h}`;

// ---------- wallet ----------
export async function ensureChain() {
  const eth = window.ethereum;
  const hex = '0x' + CHAIN_ID.toString(16);
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|not added/i.test(e?.message || '')) throw e;
    await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [dep.rpc], blockExplorerUrls: [dep.explorer] }] });
  }
}

async function wallet(account) {
  await ensureChain();
  return createWalletClient({ chain, account, transport: custom(window.ethereum) });
}

/** Simulate, then ask the wallet to sign, then wait. Returns { hash, receipt, result }. */
async function send(account, address, abi, functionName, args = []) {
  const { request, result } = await pub.simulateContract({ account, address, abi, functionName, args });
  const hash = await (await wallet(account)).writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${txUrl(hash)}`);
  return { hash, receipt, result };
}

async function approveIfNeeded(account, amount) {
  const allowance = await pub.readContract({ address: USDG, abi: usdgAbi, functionName: 'allowance', args: [account, ENGINE] });
  if (allowance < amount) await send(account, USDG, usdgAbi, 'approve', [ENGINE, amount]);
}

export const tx = {
  faucet: (a, amount = usdg(10_000)) => send(a, USDG, usdgAbi, 'mint', [a, amount]),
  async openCrystal(a) {
    const { receipt } = await send(a, ENGINE, engineAbi, 'openCrystal');
    const log = receipt.logs.find((l) => l.address.toLowerCase() === ENGINE.toLowerCase());
    return BigInt(log.topics[1]);
  },
  async deposit(a, pid, amount) { await approveIfNeeded(a, amount); return send(a, ENGINE, engineAbi, 'deposit', [pid, amount]); },
  withdraw: (a, pid, amount) => send(a, ENGINE, engineAbi, 'withdraw', [pid, amount]),
  flatten: (a, pid) => send(a, ENGINE, engineAbi, 'flatten', [pid]),
  setBeam: (a, pid, bid, p) => send(a, ENGINE, engineAbi, 'setBeam', [pid, bid, p]),
  cutBeam: (a, pid, bid) => send(a, ENGINE, engineAbi, 'cutBeam', [pid, bid]),
  rearm: (a, pid, bid) => send(a, ENGINE, engineAbi, 'rearm', [pid, bid]),
  async lpDeposit(a, amount) { await approveIfNeeded(a, amount); return send(a, ENGINE, engineAbi, 'lpDeposit', [amount]); },
  lpWithdraw: (a, shares) => send(a, ENGINE, engineAbi, 'lpWithdraw', [shares]),
};

/** Beam draft (dashboard form) -> engine BeamParams. Market list like "BTC, ETH" -> bit mask. */
export function beamParams(form) {
  const names = form.markets.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  let mask = 0;
  for (const n of names) {
    const m = MARKETS.find((x) => x.name.split('/')[0] === n);
    if (!m) throw new Error(`${n} is not listed on testnet (listed: ${MARKETS.map((x) => x.name.split('/')[0]).join(', ')}).`);
    mask |= 1 << m.id;
  }
  return {
    agent: form.agent.trim(),
    until: BigInt(Math.floor(Date.now() / 1000) + Number(form.expiry) * 86400),
    marketMask: mask,
    softBps: Math.round(Number(form.soft) * 100),
    hardBps: Math.round(Number(form.hard) * 100),
    perfFeeBps: Math.round(Number(form.performance) * 100),
    budget: wad(form.budget),
    levCap: wad(form.leverage),
  };
}

// ---------- reads ----------
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

export const usdgBalance = (a) => read(USDG, usdgAbi, 'balanceOf', [a]);

/** Crystals owned by `owner` from the index (numerics as text). */
export async function crystalsOf(owner) {
  const { data, error } = await db.from('crystals').select('id,beam_count,open_mask,collateral::text,net_deposits::text,bad_debt::text').eq('owner', owner.toLowerCase()).order('id');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function crystalLive(pid) {
  const [[equity, im, mm], gross] = await Promise.all([read(ENGINE, engineAbi, 'crystalRisk', [pid]), read(ENGINE, engineAbi, 'grossMargin', [pid])]);
  return { equity, im, mm, gross };
}

/** On-chain beams of a crystal from the index, with live equity and open positions (read from the engine). */
export async function beamsOf(pid) {
  const { data, error } = await db.from('beams').select('beam,agent,until,market_mask,soft_bps,hard_bps,perf_bps,budget::text,lev_cap::text,state,hwm::text').eq('crystal', Number(pid)).order('beam');
  if (error) throw new Error(error.message);
  return Promise.all((data ?? []).map(async (b) => {
    const ms = MARKETS; // every market, not the Beam's mask: a position can outlive a mask change
    const [equity, ...pos] = await Promise.all([
      read(ENGINE, engineAbi, 'beamEquity', [pid, BigInt(b.beam)]),
      ...ms.map((m) => read(ENGINE, engineAbi, 'beamPosition', [pid, BigInt(b.beam), BigInt(m.id)])),
    ]);
    // size and last (the mark it was last settled at) in WAD; unrealized PnL = size * (mark - last)
    const positions = ms.map((m, i) => ({ market: m.id, name: m.name, size: pos[i].size, last: pos[i].last })).filter((x) => x.size !== 0n);
    return { ...b, equity, positions };
  }));
}

export async function lens(a) {
  const [nav, reserve, total, mine, cap] = await Promise.all([
    read(ENGINE, engineAbi, 'poolNav'), read(ENGINE, engineAbi, 'lensReserve'), read(ENGINE, engineAbi, 'totalShares'),
    a ? read(ENGINE, engineAbi, 'sharesOf', [a]) : 0n, read(ENGINE, engineAbi, 'lensCap'),
  ]);
  const value = total > 0n ? (mine * BigInt(nav)) / total : 0n; // WAD USD
  return { nav, reserve, total, mine, value, cap };
}

export async function marks() {
  return Promise.all(MARKETS.map(async (m) => {
    const mk = await read(ENGINE, engineAbi, 'market', [BigInt(m.id)]);
    try {
      const [price, at, open] = await read(FEED, feedAbi, 'latest', [mk.p.feedId]);
      return { ...m, price, at: Number(at), open, skew: mk.skew };
    } catch { return { ...m, price: null, at: 0, open: false, skew: mk.skew }; }
  }));
}

/** Recent on-chain events for these crystals plus the owner's alerts. */
export async function history(owner, pids) {
  const [ev, al] = await Promise.all([
    pids.length ? db.from('events').select('tx_hash,log_index,block_time,name,crystal,beam,market,args').in('crystal', pids.map(Number)).order('block_number', { ascending: false }).limit(50) : { data: [] },
    db.from('alerts').select('id,kind,crystal,beam,payload,ts').eq('owner', owner.toLowerCase()).order('ts', { ascending: false }).limit(50),
  ]);
  return { events: ev.data ?? [], alerts: al.data ?? [] };
}

/** Live updates: calls `onChange` on any event/alert for this owner's crystals. Returns an unsubscribe function. */
export function subscribe(owner, onChange) {
  const ch = db.channel(`owner-${owner}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, onChange)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts', filter: `owner=eq.${owner.toLowerCase()}` }, onChange)
    .subscribe();
  return () => db.removeChannel(ch);
}

// ---------- Spectrum + Gym ----------
/** Listed agents with their on-chain record (ranked only from on-chain beams with real budgets). */
export async function spectrum() {
  const { data, error } = await db.from('spectrum').select('agent,perf_bps,uri,active,beams,total_budget::text,total_pnl::text,max_dd_bps,rank_score,paper_seasons,promoted,listed_at').eq('active', true).order('rank_score', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Current paper season and its entries. */
export async function gymBoard() {
  const { data: s } = await db.from('gym_seasons').select('id,ends_at').eq('status', 'open').order('id', { ascending: false }).limit(1).maybeSingle();
  if (!s) return { season: null, entries: [] };
  const { data } = await db.from('gym_entries').select('agent,state,equity::text,budget::text,fills,promoted').eq('season', s.id).order('equity', { ascending: false });
  return { season: s, entries: data ?? [] };
}

// ---------- Telegram ----------
export async function telegramLink(account) {
  const ts = Math.floor(Date.now() / 1000);
  // Must match linkMessage in services/src/api/telegram.ts.
  const message = `refractfi.org: link Telegram alerts to ${account.toLowerCase()} (Robinhood Chain Testnet). No transaction, no cost. Time: ${ts}`;
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, account] });
  const r = await fetch('/api/telegram-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: account, ts, signature }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Could not create a link code.');
  return j; // { url, code }
}
