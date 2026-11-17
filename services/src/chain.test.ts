import { expect, test } from "bun:test";
import { createNonceManager } from "viem/accounts";
import { resettableNonces } from "./chain";

// The Nov 16-17 freeze: nonce 7025 was handed out, its send failed, the chain still expects 7025.
const chainSays = { get: async () => 7025, set() {} };
const p = { address: "0x26ed1f7a450a55794D412bA65eBa486C2f60aAd6" as const, chainId: 46630, client: {} as never };

test("viem's own manager stays one ahead after reset (the bug)", async () => {
  const m = createNonceManager({ source: chainSays });
  expect(await m.consume(p)).toBe(7025);
  m.reset(p);
  expect(await m.consume(p)).toBe(7026); // chain expects 7025: "nonce higher than expected" forever
});

test("resettableNonces goes back to the chain's nonce after a failed send", async () => {
  const m = resettableNonces(chainSays);
  expect(await m.consume(p)).toBe(7025);
  m.reset(p);
  expect(await m.consume(p)).toBe(7025);
});
