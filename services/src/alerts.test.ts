import { expect, test } from "bun:test";
import { isStopBreach, lowWallets } from "./alerts";
import { parseEther } from "viem";

const W = 10n ** 18n;

test("hard-stop breach matches the engine's enforce rule", () => {
  const hwm = 1000n * W;
  expect(isStopBreach(925n * W, hwm, 750)).toBe(true); // exactly at the 7.5% line
  expect(isStopBreach(900n * W, hwm, 750)).toBe(true);
  expect(isStopBreach(926n * W, hwm, 750)).toBe(false); // owner cut above the line: no alert
});

test("low-balance alarm: pusher has a higher floor than the rest", () => {
  const bal = { pusher: parseEther("0.0029"), keeper: parseEther("0.0029"), settler: parseEther("0.0001"), poster: parseEther("0.0002") };
  expect(lowWallets(bal)).toEqual(["pusher", "settler"]);
});
