import { expect, test } from "bun:test";
import { decodeAbiParameters, keccak256, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agreeMedian, signReport, toPush, usMarketOpen, v3Report, WAD } from "./pusher";

test("US regular session in New York time", () => {
  expect(usMarketOpen(new Date("2026-11-16T14:29:00Z"))).toBe(false); // Mon 09:29 ET
  expect(usMarketOpen(new Date("2026-11-16T14:30:00Z"))).toBe(true); // 09:30 ET
  expect(usMarketOpen(new Date("2026-11-16T20:59:00Z"))).toBe(true); // 15:59 ET
  expect(usMarketOpen(new Date("2026-11-16T21:00:00Z"))).toBe(false); // 16:00 ET
  expect(usMarketOpen(new Date("2026-11-21T16:00:00Z"))).toBe(false); // Saturday
});

test("pushes for freshness every 20 s and the exact close of windows with orders", () => {
  const none = new Set<number>();
  expect(toPush(1000, 980, 20, [], none)).toEqual([1000]); // 20 s since last fresh push
  expect(toPush(1005, 1000, 20, [], none)).toEqual([]); // fresh enough, no orders: nothing on-chain
  expect(toPush(1005, 1000, 20, [1005], none)).toEqual([1005]); // a window with orders closed now
  expect(toPush(1010, 1000, 20, [1005], none)).toEqual([1005]); // its orders were mined late: push its close
  expect(toPush(1010, 1000, 20, [1005], new Set([1005]))).toEqual([]); // already pushed
  expect(toPush(1020, 1000, 20, [1015, 1020], none)).toEqual([1015, 1020]);
});

test("median needs two agreeing sources", () => {
  expect(agreeMedian([100n * WAD])).toBeNull();
  expect(agreeMedian([100n * WAD, 102n * WAD])).toBeNull(); // 2% apart
  expect(agreeMedian([100n * WAD, 100n * WAD + WAD / 2n])).toBe(100n * WAD + WAD / 4n);
  expect(agreeMedian([101n * WAD, 100n * WAD, 100n * WAD + WAD / 2n])).toBe(100n * WAD + WAD / 2n);
});

test("signed payload decodes and recovers to the pusher", async () => {
  const acct = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a11ce");
  const feedId = "0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439" as Hex;
  const data = v3Report(feedId, 1_700_000_005, 90_000n * WAD);
  const full = await signReport(acct, data);
  const [, reportData, rs, ss, vs] = decodeAbiParameters(
    [{ type: "bytes32[3]" }, { type: "bytes" }, { type: "bytes32[]" }, { type: "bytes32[]" }, { type: "bytes32" }],
    full,
  );
  expect(reportData).toBe(data);
  const v = BigInt(vs);
  expect(v === 27n || v === 28n).toBe(true);
  const sig = `${rs[0]}${ss[0].slice(2)}${v.toString(16)}` as Hex;
  expect(await recoverMessageAddress({ message: { raw: keccak256(data) }, signature: sig })).toBe(acct.address);
});

import { safeUri } from "./mcp-server";
test("listing links: only https and ipfs", () => {
  expect(safeUri("https://example.com/card")).toBe("https://example.com/card");
  expect(safeUri("ipfs://bafy123")).toBe("ipfs://bafy123");
  expect(safeUri("javascript:alert(1)")).toBeNull();
  expect(safeUri("data:text/html,hi")).toBeNull();
  expect(safeUri("not a url")).toBeNull();
});

test("a price source is down when it was asked recently but hasn't answered for 10 min", async () => {
  const { downSources } = await import("./pusher");
  const now = 1_000_000_000, M = 60_000;
  const h = {
    coinbase: { tried: now - 5_000, ok: now - 5_000 },   // fine
    kraken: { tried: now - 5_000, ok: now - 11 * M },    // failing 11 min: down
    nasdaq: { tried: now - 60 * M, ok: now - 70 * M },   // not asked lately (market closed): not an alarm
  };
  expect(downSources(h, now, 10 * M)).toEqual([{ name: "kraken", mins: 11 }]);
});
