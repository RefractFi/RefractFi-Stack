import { expect, test } from "bun:test";
import { freshness } from "./check-soak";

test("soak freshness: pushes every 20 s are fully fresh; a gap counts only beyond maxAge", () => {
  const every20 = Array.from({ length: 31 }, (_, i) => 1000 + i * 20); // 1000..1600
  expect(freshness(every20, 1000, 1600)).toEqual({ fresh: 1, worst: 30 });
  const gap = every20.filter((t) => t < 1200 || t > 1400); // 1180 -> 1420: 240 s gap, 210 s stale
  expect(freshness(gap, 1000, 1600)).toEqual({ fresh: 1 - 210 / 600, worst: 240 });
});
