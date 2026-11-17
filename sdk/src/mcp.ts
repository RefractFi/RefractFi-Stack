import { encodeFunctionData, type Address, type Hex } from "viem";
import { engineAbi } from "./abi.js";
import { checkBeamOrder, type BeamView } from "./gate.js";
import { routeQuote } from "./cross.js";
import type { MarketParams } from "./math.js";
import { leafOf, type Trace } from "./traces.js";

/** Read side the MCP server needs. Production: viem public client + indexer. Tests: in-memory. */
export interface Reader {
  now(): number;
  opensPaused(): Promise<boolean>;
  mark(m: number): Promise<{ mark: bigint; open: boolean }>;
  skew(m: number): Promise<bigint>;
  windowFlow(m: number): Promise<bigint>; // signed size already queued in the current window
  marketParams(m: number): Promise<MarketParams>;
  beam(pid: bigint, bid: number): Promise<BeamView>;
  beamSize(pid: bigint, bid: number, m: number): Promise<bigint>;
  crystalRisk(pid: bigint): Promise<{ equity: bigint; im: bigint; mm: bigint; grossIm: bigint }>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const int = { type: "string", description: "integer, 18 decimals" };
const num = { type: "integer" };

export const tools: Tool[] = [
  { name: "crystal_status", description: "Equity, net margin and what the same book would need if each agent were margined alone.", inputSchema: { type: "object", properties: { crystal: int }, required: ["crystal"] } },
  { name: "beam_status", description: "Your beam: state, budget, cap in use, pending crossing orders.", inputSchema: { type: "object", properties: { crystal: int, beam: num }, required: ["crystal", "beam"] } },
  { name: "quote_route", description: "Cost of trading now against the pool vs joining the next crossing window.", inputSchema: { type: "object", properties: { market: num, size: int }, required: ["market", "size"] } },
  { name: "check_order", description: "Runs the engine's beam rules off-chain. Same rules, same error names.", inputSchema: { type: "object", properties: { crystal: int, beam: num, market: num, size: int, route: { enum: ["lens", "cross"] } }, required: ["crystal", "beam", "market", "size", "route"] } },
  { name: "prepare_trade", description: "Unsigned calldata for an immediate fill. Refuses if the rules would refuse.", inputSchema: { type: "object", properties: { crystal: int, beam: num, market: num, size: int, limitPrice: int }, required: ["crystal", "beam", "market", "size"] } },
  { name: "prepare_cross", description: "Unsigned calldata to join the current crossing window.", inputSchema: { type: "object", properties: { crystal: int, beam: num, market: num, size: int, maxSlipBps: num }, required: ["crystal", "beam", "market", "size", "maxSlipBps"] } },
  { name: "trace_leaf", description: "Hash of a decision trace, for the epoch receipt root.", inputSchema: { type: "object", properties: { trace: { type: "object" } }, required: ["trace"] } },
];

type Args = Record<string, unknown>;
const big = (v: unknown) => BigInt(v as string);

export async function handle(name: string, a: Args, r: Reader, engine: Address): Promise<unknown> {
  switch (name) {
    case "crystal_status":
      return r.crystalRisk(big(a.crystal));
    case "beam_status":
      return r.beam(big(a.crystal), Number(a.beam));
    case "quote_route": {
      const m = Number(a.market);
      const [{ mark }, skew, flow, mp] = await Promise.all([r.mark(m), r.skew(m), r.windowFlow(m), r.marketParams(m)]);
      return routeQuote(big(a.size), mark, skew, -flow, mp);
    }
    case "check_order":
    case "prepare_trade":
    case "prepare_cross": {
      const pid = big(a.crystal);
      const bid = Number(a.beam);
      const m = Number(a.market);
      const size = big(a.size);
      const [beam, cur, { mark, open }, paused] = await Promise.all([r.beam(pid, bid), r.beamSize(pid, bid, m), r.mark(m), r.opensPaused()]);
      const queued = name === "prepare_cross" || a.route === "cross";
      const verdict = checkBeamOrder({ beam, market: m, currentSize: cur, size, mark, marketOpen: open, opensPaused: paused, now: r.now(), queued });
      if (name === "check_order" || !verdict.ok) return verdict;
      const data: Hex =
        name === "prepare_trade"
          ? encodeFunctionData({ abi: engineAbi, functionName: "trade", args: [pid, BigInt(bid), BigInt(m), size, a.limitPrice ? big(a.limitPrice) : 0n] })
          : encodeFunctionData({ abi: engineAbi, functionName: "queueCross", args: [pid, BigInt(bid), BigInt(m), size, Number(a.maxSlipBps)] });
      return { ok: true, to: engine, data, value: "0", note: "unsigned: sign with this beam's agent key" };
    }
    case "trace_leaf":
      return leafOf(a.trace as Trace);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
