// window-settler: settles every crossing window that has orders, right after it closes, at the exact-close price.
// If the window can't be priced by the end of the 120 s grace, it is voided so reservations are released.
import { engine, engineAbi, newStatus, pub, scrub, signer, simulateThenSend } from "./chain";

const WINDOW = 5;
const GRACE = 120;
const BACKFILL_BLOCKS = 1500n; // ~6 min at ~4 blocks/s: covers every window still inside its grace
const MAX_RANGE = 2000n;

export const status = { ...newStatus(), settled: 0, voided: 0, pending: 0 };

export type Win = { m: bigint; w: bigint };
export type Step = "wait" | "settle" | "void";

/** What to do with a window at wall-clock `now` given the last settle refusal (if any). */
export function step(win: Win, now: number, lastRefusal?: string): Step {
  const end = Number(win.w + 1n) * WINDOW;
  if (now < end + 1) return "wait"; // give the pusher's exact-close report a second to land
  if (lastRefusal && lastRefusal !== "WindowOpen" && now > end + GRACE + 2) return "void";
  return "settle";
}

export async function startSettler() {
  const s = signer("SETTLER_PK");
  const pending = new Map<string, Win & { refusal?: string }>();
  let from = (await pub.getBlockNumber()) - BACKFILL_BLOCKS;
  console.log(`[settler] ${s.account.address} watching ${engine}`);

  for (;;) {
    try {
      const latest = await pub.getBlockNumber();
      while (from <= latest) {
        const to = from + MAX_RANGE - 1n < latest ? from + MAX_RANGE - 1n : latest;
        const logs = await pub.getContractEvents({ address: engine, abi: engineAbi, eventName: "Queued", fromBlock: from, toBlock: to });
        for (const l of logs) {
          const { market: m, window: w } = l.args as { market: bigint; window: bigint };
          pending.set(`${m}:${w}`, { m, w });
        }
        from = to + 1n;
      }

      const now = Date.now() / 1000;
      for (const [key, win] of pending) {
        const act = step(win, now, win.refusal);
        if (act === "wait") continue;
        const r = await simulateThenSend(s, act === "void" ? "voidWindow" : "settleWindow", [win.m, win.w]);
        if ("hash" in r) {
          pending.delete(key);
          status.sent++;
          status.lastTx = r.hash!;
          act === "void" ? status.voided++ : status.settled++;
          console.log(`[settler] ${act} m${win.m} w${win.w} ${r.hash}`);
        } else if (r.refused === "AlreadySettled") {
          pending.delete(key); // someone else settled or voided it
        } else {
          if (win.refusal !== r.refused) console.warn(`[settler] m${win.m} w${win.w} ${act} refused: ${r.refused}`);
          win.refusal = r.refused;
        }
      }
      status.pending = pending.size;
      status.lastPoll = Date.now();
    } catch (e) {
      status.lastErr = scrub(e);
      console.error(`[settler] ${status.lastErr}`);
    }
    await Bun.sleep(1000);
  }
}
