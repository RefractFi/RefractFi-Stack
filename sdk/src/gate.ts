import { WAD, abs, type BeamState } from "./math.js";

export interface BeamView {
  state: BeamState;
  until: number; // unix seconds
  marketMask: number;
  budget: bigint; // WAD
  levCap: bigint; // WAD
  gross: bigint; // current gross notional, WAD
  pending: bigint; // notional queued in open windows, WAD
}

export interface GateInput {
  beam: BeamView;
  market: number;
  currentSize: bigint; // beam's virtual size in this market
  size: bigint; // order
  mark: bigint;
  marketOpen: boolean;
  opensPaused: boolean;
  now: number;
  queued?: boolean; // crossing order: pending notional counts against the cap
}

export type GateResult = { ok: true; increases: boolean } | { ok: false; reason: string };

/** Off-chain mirror of the engine's beam checks. Same rules, same order, same error names. */
export function checkBeamOrder(g: GateInput): GateResult {
  const b = g.beam;
  if (g.now > b.until) return { ok: false, reason: "BeamExpired" };
  if (b.state === "Cut") return { ok: false, reason: "BeamClosed" };
  if (((b.marketMask >> g.market) & 1) === 0) return { ok: false, reason: "MarketNotAllowed" };
  const s0 = g.currentSize;
  const s1 = s0 + g.size;
  const increases = abs(s1) > abs(s0) || (s0 !== 0n && s1 !== 0n && s1 > 0n !== s0 > 0n);
  if (!increases) return { ok: true, increases };
  if (g.opensPaused) return { ok: false, reason: "OpensPaused" };
  if (!g.marketOpen) return { ok: false, reason: "MarketClosed" };
  let cap = (b.budget * b.levCap) / WAD;
  if (b.state === "Halved") cap /= 2n;
  const gross = b.gross - (abs(s0) * g.mark) / WAD + (abs(s1) * g.mark) / WAD + (g.queued ? b.pending : 0n);
  if (gross > cap) return { ok: false, reason: "OverBeamCap" };
  return { ok: true, increases };
}
