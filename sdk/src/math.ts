// Exact bigint mirror of RefractEngine maths. Solidity and JS bigint both truncate signed division toward zero.
export const WAD = 10n ** 18n;
export const DAY = 86_400n;

export const abs = (x: bigint) => (x < 0n ? -x : x);
export const wad = (x: number | string) => {
  const [i, f = ""] = String(x).split(".");
  const neg = i.startsWith("-");
  const frac = (f + "0".repeat(18)).slice(0, 18);
  const v = BigInt(i.replace("-", "") || "0") * WAD + BigInt(frac);
  return neg ? -v : v;
};
export const fromWad = (x: bigint, dp = 6) => Number((x * 10n ** BigInt(dp)) / WAD) / 10 ** dp;

export interface MarketParams {
  maxLev: bigint; // WAD
  mmr: bigint; // WAD
  takerFeeBps: number;
  crossFeeBps: number;
  skewScale: bigint; // WAD base units
  maxFundingPerDay: bigint; // WAD
  maxSkew: bigint; // WAD base units
}

/** Lens fill price: premium = average skew across the trade / skewScale, clamped to ±10%. */
export function fillPrice(mark: bigint, skew: bigint, size: bigint, skewScale: bigint): bigint {
  const avgSkew = skew + size / 2n;
  let premium = (avgSkew * WAD) / skewScale;
  if (premium > WAD / 10n) premium = WAD / 10n;
  if (premium < -WAD / 10n) premium = -WAD / 10n;
  return (mark * (WAD + premium)) / WAD;
}

export function fee(size: bigint, price: bigint, bps: number): bigint {
  return (((abs(size) * price) / WAD) * BigInt(bps)) / 10_000n;
}

/** Funding index after dt seconds at a constant skew and mark. Longs owe size × Δindex. */
export function indexAfter(index: bigint, skew: bigint, skewScale: bigint, maxPerDay: bigint, mark: bigint, dt: bigint): bigint {
  if (dt === 0n || skew === 0n) return index;
  let frac = (skew * WAD) / skewScale;
  if (frac > WAD) frac = WAD;
  if (frac < -WAD) frac = -WAD;
  const ratePerDay = (frac * maxPerDay) / WAD;
  return index + (((ratePerDay * mark) / WAD) * dt) / DAY;
}

export interface Pos {
  size: bigint;
  last: bigint;
  f0: bigint;
}

export const unrealized = (p: Pos, mark: bigint, index: bigint) =>
  (p.size * (mark - p.last) - p.size * (index - p.f0)) / WAD;

export type BeamState = "Active" | "Halved" | "Cut";

/** Pod-shop drawdown rule: soft breach halves the budget, hard breach cuts the beam. */
export function drawdownState(state: BeamState, equity: bigint, hwm: bigint, softBps: number, hardBps: number): BeamState {
  if (state === "Cut") return "Cut";
  if (equity <= hwm - (hwm * BigInt(hardBps)) / 10_000n) return "Cut";
  if (equity <= hwm - (hwm * BigInt(softBps)) / 10_000n) return "Halved";
  return state;
}
