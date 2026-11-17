import { expect, test } from "bun:test";
import { paperEquity, paperFill } from "./gym";

const W = 10n ** 18n;
const fee = (size: bigint, price: bigint) => ((size < 0n ? -size : size) * price) / W * 5n / 10_000n;

test("open, add, reduce, flip: realized PnL and average entry", () => {
  let r = paperFill(undefined, 2n * W, 100n * W);
  expect(r.pos).toEqual({ size: 2n * W, entry: 100n * W });
  expect(r.realized).toBe(-fee(2n * W, 100n * W));

  r = paperFill(r.pos, 2n * W, 110n * W); // add at 110: average entry 105
  expect(r.pos).toEqual({ size: 4n * W, entry: 105n * W });

  r = paperFill(r.pos, -1n * W, 125n * W); // sell 1 at 125: +20 realized
  expect(r.pos).toEqual({ size: 3n * W, entry: 105n * W });
  expect(r.realized).toBe(20n * W - fee(W, 125n * W));

  r = paperFill(r.pos, -5n * W, 95n * W); // sell 5 at 95: close 3 for -30, flip to short 2 at 95
  expect(r.pos).toEqual({ size: -2n * W, entry: 95n * W });
  expect(r.realized).toBe(-30n * W - fee(5n * W, 95n * W));

  expect(paperFill({ size: W, entry: 100n * W }, -W, 100n * W).pos).toBeUndefined();
});

test("equity marks open positions", () => {
  expect(paperEquity(1000n * W, -5n * W, { "0": { size: 2n * W, entry: 100n * W } }, { "0": 110n * W })).toBe(1015n * W);
});

test("zero-size fills change nothing (no divide by zero)", () => {
  expect(paperFill(undefined, 0n, 100n * W)).toEqual({ pos: undefined, realized: 0n });
});
