import { describe, it, expect } from "vitest";
import { toFunctionSelector, keccak256, concat, type Hex } from "viem";
import {
  WAD, wad, fillPrice, fee, indexAfter, drawdownState, unrealized,
  checkBeamOrder, settleWindow, routeQuote, simulate, buildTree, verify, leafOf, canonical,
  tools, handle, type MarketParams, type Reader, type BeamView,
} from "../src/index.js";

const BTC: MarketParams = {
  maxLev: wad(20), mmr: wad("0.025"), takerFeeBps: 5, crossFeeBps: 1,
  skewScale: wad(10_000), maxFundingPerDay: wad("0.01"), maxSkew: wad(500),
};

// Values below are the same ones the Foundry suite asserts against the contract.
describe("parity with RefractEngine", () => {
  it("Lens fill price and taker fee", () => {
    const F = fillPrice(wad(100_000), 0n, wad(1), BTC.skewScale);
    expect(F).toBe(wad(100_005));
    expect(fee(wad(1), F, 5)).toBe(wad("50.0025"));
  });

  it("crossing: matched at mark, residual to the Lens", () => {
    const r = settleWindow(
      [ { id: "a1", size: wad(3), maxSlipBps: 50 }, { id: "b1", size: wad(-2), maxSlipBps: 50 } ],
      wad(101_000), 0n, BTC,
    );
    expect(r.matched).toBe(wad(2));
    expect(r.residualFilled).toBe(true);
    expect(r.lensPrice).toBe(wad("101005.05"));
    expect(r.fills[0]).toMatchObject({ crossed: wad(2), residual: wad(1) });
    expect(r.fills[1].crossedFee).toBe(wad("20.2"));
    expect(r.skewAfter).toBe(wad(1));
  });

  it("crossing: pro rata on the heavy side, residual dropped when slip is zero", () => {
    const r = settleWindow(
      [ { id: "a1", size: wad(3), maxSlipBps: 0 }, { id: "a2", size: wad(1), maxSlipBps: 0 }, { id: "b1", size: wad(-2), maxSlipBps: 0 } ],
      wad(100_000), 0n, BTC,
    );
    expect(r.residualFilled).toBe(false);
    expect(r.fills.map((f) => f.crossed)).toEqual([wad("1.5"), wad("0.5"), wad(-2)]);
    expect(r.skewAfter).toBe(0n);
  });

  it("dust goes to the last heavy order so crossed quantities sum exactly", () => {
    const r = settleWindow(
      [ { id: "x", size: 1n, maxSlipBps: 0 }, { id: "y", size: 1n, maxSlipBps: 0 }, { id: "z", size: 1n, maxSlipBps: 0 }, { id: "s", size: -2n, maxSlipBps: 0 } ],
      wad(100), 0n, BTC,
    );
    const crossedBuys = r.fills.filter((f) => f.crossed > 0n).reduce((s, f) => s + f.crossed, 0n);
    expect(crossedBuys).toBe(2n);
  });

  it("funding: one day of 50 BTC long skew costs $250 on $5M", () => {
    const I = indexAfter(0n, wad(50), BTC.skewScale, BTC.maxFundingPerDay, wad(100_000), 86_400n);
    expect((wad(50) * I) / WAD).toBe(wad(250));
    expect(unrealized({ size: wad(50), last: wad(100_000), f0: 0n }, wad(100_000), I)).toBe(wad(-250));
  });

  it("pod-shop drawdown states", () => {
    expect(drawdownState("Active", wad(9_411), wad(10_000), 500, 750)).toBe("Halved");
    expect(drawdownState("Halved", wad(9_006), wad(10_000), 500, 750)).toBe("Cut");
    expect(drawdownState("Active", wad(9_600), wad(10_000), 500, 750)).toBe("Active");
  });
});

const beam = (o: Partial<BeamView> = {}): BeamView => ({
  state: "Active", until: 2_000_000_000, marketMask: 3, budget: wad(10_000), levCap: wad(5), gross: 0n, pending: 0n, ...o,
});

describe("gate", () => {
  const base = { market: 0, currentSize: 0n, mark: wad(100_000), marketOpen: true, opensPaused: false, now: 1_800_000_000 };
  it("caps, halving, masks, pause and off-hours", () => {
    expect(checkBeamOrder({ ...base, beam: beam(), size: wad("0.6") })).toEqual({ ok: false, reason: "OverBeamCap" });
    expect(checkBeamOrder({ ...base, beam: beam(), size: wad("0.4") })).toEqual({ ok: true, increases: true });
    expect(checkBeamOrder({ ...base, beam: beam({ state: "Halved" }), size: wad("0.4") })).toEqual({ ok: false, reason: "OverBeamCap" });
    expect(checkBeamOrder({ ...base, beam: beam({ marketMask: 2 }), size: wad("0.1") })).toEqual({ ok: false, reason: "MarketNotAllowed" });
    expect(checkBeamOrder({ ...base, beam: beam(), size: wad("0.1"), opensPaused: true })).toEqual({ ok: false, reason: "OpensPaused" });
    // reducing is always allowed, even closed and paused
    expect(checkBeamOrder({ ...base, beam: beam(), currentSize: wad(1), size: wad("-0.5"), marketOpen: false, opensPaused: true })).toEqual({ ok: true, increases: false });
    expect(checkBeamOrder({ ...base, beam: beam({ state: "Cut" }), size: wad("0.1") })).toEqual({ ok: false, reason: "BeamClosed" });
  });
});

describe("routing and refraction", () => {
  it("crossing beats the Lens when opposite flow is queued", () => {
    const q = routeQuote(wad(2), wad(100_000), 0n, wad(-2), BTC);
    expect(q.saving > 0n).toBe(true);
    expect(q.crossCost).toBe(fee(wad(2), wad(100_000), 1));
  });

  it("two opposite agents: zero net margin, most fees internalised", () => {
    const r = simulate(
      [ { id: "trend", positions: { BTC: [1, 2, 2, 1, 0] } }, { id: "meanrev", positions: { BTC: [-1, -2, -1, -1, 0] } } ],
      { BTC: { prices: [100_000, 101_000, 99_000, 100_500, 100_000], maxLev: 20, takerFeeBps: 5, crossFeeBps: 1 } },
    );
    expect(r.peakGrossMargin).toBeGreaterThan(0);
    expect(r.peakNetMargin).toBeLessThan(r.peakGrossMargin);
    expect(r.feesSavedPct).toBeGreaterThan(50);
    expect(r.internalisedPct).toBeGreaterThan(70);
  });
});

describe("decision traces", () => {
  const trace = (i: number) => ({
    crystal: "1", beam: i, agent: "0xabc", ts: 1_800_000_000 + i,
    saw: { market: 0, mark: "100000", skew: "0", equity: "10000", hwm: "10000" },
    proposed: { route: "cross" as const, size: "1", maxSlipBps: 20 },
    gate: { ok: true },
  });
  it("canonical JSON is key-order independent", () => {
    expect(canonical({ b: 1, a: [2n, { d: 1, c: 2 }] })).toBe('{"a":["2",{"c":2,"d":1}],"b":1}');
  });
  it("two-leaf root equals TraceRoots' sorted-pair hash", () => {
    const a = leafOf(trace(0));
    const b = leafOf(trace(1));
    const expected = a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
    expect(buildTree([a, b]).root).toBe(expected);
  });
  it("every proof verifies in an odd-sized tree", () => {
    const leaves = [0, 1, 2, 3, 4].map((i) => leafOf(trace(i)));
    const { root, proofs } = buildTree(leaves);
    leaves.forEach((l, i) => expect(verify(root, l, proofs[i])).toBe(true));
    expect(verify(root, leafOf(trace(9)), proofs[0])).toBe(false);
  });
});

describe("MCP surface", () => {
  const reader = (b: BeamView): Reader => ({
    now: () => 1_800_000_000,
    opensPaused: async () => false,
    mark: async () => ({ mark: wad(100_000), open: true }),
    skew: async () => 0n,
    windowFlow: async () => wad(-1),
    marketParams: async () => BTC,
    beam: async () => b,
    beamSize: async () => 0n,
    crystalRisk: async () => ({ equity: wad(100_000), im: 0n, mm: 0n, grossIm: 0n }),
  });
  const engine = "0x00000000000000000000000000000000000000Aa";

  it("lists tools; only prepare_* write anything, and they return unsigned calldata", async () => {
    expect(tools.map((t) => t.name)).toEqual(["crystal_status", "beam_status", "quote_route", "check_order", "prepare_trade", "prepare_cross", "trace_leaf"]);
    const out = (await handle("prepare_trade", { crystal: "1", beam: 0, market: 0, size: wad("0.1").toString() }, reader(beam()), engine)) as { data: Hex };
    expect(out.data.slice(0, 10)).toBe(toFunctionSelector("function trade(uint256,uint256,uint256,int256,int256)"));
  });

  it("refuses to prepare an order the engine would refuse", async () => {
    const out = await handle("prepare_cross", { crystal: "1", beam: 0, market: 0, size: wad(1).toString(), maxSlipBps: 20 }, reader(beam()), engine);
    expect(out).toEqual({ ok: false, reason: "OverBeamCap" });
  });

  it("quotes the route with queued opposite flow", async () => {
    const q = (await handle("quote_route", { market: 0, size: wad(1).toString() }, reader(beam()), engine)) as { saving: bigint };
    expect(q.saving > 0n).toBe(true);
  });
});
