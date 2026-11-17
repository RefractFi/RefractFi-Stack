import { expect, test } from "bun:test";
import { step } from "./settler";

const win = { m: 0n, w: 100n }; // closes at (100 + 1) * 5 = 505

test("waits for the close plus a second for the pusher's report", () => {
  expect(step(win, 504)).toBe("wait");
  expect(step(win, 505.5)).toBe("wait");
  expect(step(win, 506)).toBe("settle");
});

test("keeps trying to settle inside the grace, voids after it only if settling was refused", () => {
  expect(step(win, 600, "NoPriceAt")).toBe("settle"); // 95 s after close: still inside 120 s grace
  expect(step(win, 628, "NoPriceAt")).toBe("void");
  expect(step(win, 628)).toBe("settle"); // never tried yet: try settling first
  expect(step(win, 628, "WindowOpen")).toBe("settle"); // chain clock behind: not a pricing failure
});
