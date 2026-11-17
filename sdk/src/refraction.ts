// Refraction simulator: what netting several agents under one crystal saves versus running each one alone.
// Floating point is fine here: this is planning output, not settlement.

export interface AgentPath {
  id: string;
  // target position per step, per market (base units)
  positions: Record<string, number[]>;
}

export interface SimMarket {
  prices: number[];
  maxLev: number;
  takerFeeBps: number;
  crossFeeBps: number;
}

export interface SimResult {
  steps: number;
  peakGrossMargin: number; // margin if every agent had its own account
  peakNetMargin: number; // margin on the crystal's net position
  marginSavedPct: number;
  standaloneFees: number; // every change traded alone against the pool
  refractedFees: number; // same-step opposite changes cross; only the net change pays the taker fee
  feesSavedPct: number;
  internalisedPct: number; // share of traded notional that never reached the pool
}

export function simulate(agents: AgentPath[], markets: Record<string, SimMarket>): SimResult {
  const names = Object.keys(markets);
  const steps = Math.min(...names.map((m) => markets[m].prices.length));
  let peakGross = 0;
  let peakNet = 0;
  let standalone = 0;
  let refracted = 0;
  let traded = 0;
  let internal = 0;
  for (let t = 0; t < steps; t++) {
    let gross = 0;
    let net = 0;
    for (const m of names) {
      const mk = markets[m];
      const px = mk.prices[t];
      let netPos = 0;
      let buys = 0;
      let sells = 0;
      for (const a of agents) {
        const path = a.positions[m] ?? [];
        const now = path[t] ?? 0;
        const prev = t === 0 ? 0 : (path[t - 1] ?? 0);
        const d = now - prev;
        if (d > 0) buys += d;
        else sells -= d;
        gross += (Math.abs(now) * px) / mk.maxLev;
        netPos += now;
      }
      net += (Math.abs(netPos) * px) / mk.maxLev;
      const matched = Math.min(buys, sells);
      const residual = Math.abs(buys - sells);
      standalone += ((buys + sells) * px * mk.takerFeeBps) / 10_000;
      refracted += (2 * matched * px * mk.crossFeeBps) / 10_000 + (residual * px * mk.takerFeeBps) / 10_000;
      traded += (buys + sells) * px;
      internal += 2 * matched * px;
    }
    peakGross = Math.max(peakGross, gross);
    peakNet = Math.max(peakNet, net);
  }
  const pct = (a: number, b: number) => (b === 0 ? 0 : (100 * (b - a)) / b);
  return {
    steps,
    peakGrossMargin: peakGross,
    peakNetMargin: peakNet,
    marginSavedPct: pct(peakNet, peakGross),
    standaloneFees: standalone,
    refractedFees: refracted,
    feesSavedPct: pct(refracted, standalone),
    internalisedPct: traded === 0 ? 0 : (100 * internal) / traded,
  };
}
