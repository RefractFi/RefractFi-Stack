import { expect, test } from "bun:test";
import { enforceOrder, rotate } from "./guard";

test("beams that errored are retried first; ones no longer in the work set are dropped", () => {
  const list: [bigint, bigint][] = [[1n, 0n], [2n, 0n], [3n, 0n]];
  expect(enforceOrder(list, [1n, 0n], [[3n, 0n], [9n, 9n]])).toEqual([[3n, 0n], [2n, 0n], [1n, 0n]]);
});

test("stop checks resume after the last beam visited, stable as the list changes", () => {
  const list: [bigint, bigint][] = [[1n, 0n], [1n, 1n], [2n, 0n], [5n, 3n]];
  expect(rotate(list, null)).toEqual(list);
  expect(rotate(list, [1n, 1n])).toEqual([[2n, 0n], [5n, 3n], [1n, 0n], [1n, 1n]]);
  // the last-visited beam disappeared (cut): resume at the next key, not a shifted index
  expect(rotate([[1n, 0n], [2n, 0n], [5n, 3n]], [1n, 1n])).toEqual([[2n, 0n], [5n, 3n], [1n, 0n]]);
  expect(rotate(list, [9n, 0n])).toEqual(list); // past the end: start over
});

test("at most 5 retries lead a poll, so the rotation always gets its share", () => {
  const list: [bigint, bigint][] = Array.from({ length: 12 }, (_, i) => [BigInt(i), 0n] as [bigint, bigint]);
  const retry = list.slice(0, 8);
  expect(enforceOrder(list, null, retry).slice(0, 6)).toEqual([...list.slice(0, 5), list[5]]);
});
