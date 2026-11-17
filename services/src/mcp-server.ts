// MCP server for agents (Streamable HTTP, stateless, JSON responses). Bundled to api/mcp.js for Vercel by
// `bun run build:api`; `bun src/mcp-dev.ts` serves it locally on :8790 for testing.
// Tools come from the kit SDK (sdk/src/mcp.ts); this file supplies the live Reader and stores signed traces.
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseAbi, recoverMessageAddress, type Hex } from "viem";
import { handle, leafOf, tools, type Reader, type Trace } from "../../sdk/src/index.js";
import { encodeFunctionData } from "viem";
import { deploy } from "./config";
import { pub } from "./chain";
import { gymHandle, gymTools } from "./gym";

const REGISTRY = deploy.contracts.SpectrumRegistry.address as Hex;
export { safeUri } from "./safeUri";
import { safeUri } from "./safeUri";
const listingAbi = parseAbi(["function list(uint16 perfFeeBps, string uri)"]);
const listingTool = {
  name: "prepare_listing",
  description: "Unsigned calldata to list your agent on Spectrum (SpectrumRegistry.list). perfFeeBps <= 3000; uri points to your strategy card. Send it from your agent key.",
  inputSchema: { type: "object", properties: { perfFeeBps: { type: "integer" }, uri: { type: "string" } }, required: ["perfFeeBps", "uri"] },
};

const E = deploy.contracts.RefractEngine.address as Hex;
const FEED = deploy.contracts.StreamsFeed.address as Hex;
const STATES = ["Cut", "Active", "Halved", "Cut"] as const; // engine None (no beam) reads as closed
const MAX_TRACE_BYTES = 8_000;

const abi = parseAbi([
  "function opensPaused() view returns (bool)",
  "function market(uint256 m) view returns (((bytes32 feedId, int256 maxLev, int256 mmr, uint16 takerFeeBps, uint16 crossFeeBps, int256 skewScale, int256 maxFundingPerDay, int256 maxSkew, uint32 maxAge) p, bool listed, int256 skew, int256 sumSL, int256 sumSF, int256 fundingIndex, uint64 lastAccrual))",
  "function beam(uint256 pid, uint256 bid) view returns (((address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap) p, uint8 state, uint32 openMask, int256 realized, int256 hwm, int256 feeHwm, uint64 lastCrystal, int256 pending))",
  "function beamGross(uint256 pid, uint256 bid) view returns (int256)",
  "function beamPosition(uint256 pid, uint256 bid, uint256 m) view returns ((int256 size, int256 last, int256 f0))",
  "function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)",
  "function grossMargin(uint256 pid) view returns (int256)",
  "function latest(bytes32 feedId) view returns (int256 price, uint64 observedAt, bool open)",
  "event Queued(uint256 indexed market, uint64 indexed window, uint256 crystal, uint256 beam, int256 size)",
]);
const read = (address: Hex, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName: functionName as never, args: args as never }) as Promise<any>;

const reader: Reader = {
  now: () => Math.floor(Date.now() / 1000),
  opensPaused: () => read(E, "opensPaused"),
  async mark(m) {
    const mk = await read(E, "market", [BigInt(m)]);
    const [price, , open] = await read(FEED, "latest", [mk.p.feedId]);
    return { mark: price, open };
  },
  skew: async (m) => (await read(E, "market", [BigInt(m)])).skew,
  async windowFlow(m) {
    const w = BigInt(Math.floor(Date.now() / 1000 / 5));
    const logs = await pub.getContractEvents({ address: E, abi, eventName: "Queued", args: { market: BigInt(m), window: w }, fromBlock: (await pub.getBlockNumber()) - 200n });
    return logs.reduce((s, l) => s + (l.args.size ?? 0n), 0n);
  },
  async marketParams(m) {
    const { p } = await read(E, "market", [BigInt(m)]);
    return { maxLev: p.maxLev, mmr: p.mmr, takerFeeBps: p.takerFeeBps, crossFeeBps: p.crossFeeBps, skewScale: p.skewScale, maxFundingPerDay: p.maxFundingPerDay, maxSkew: p.maxSkew };
  },
  async beam(pid, bid) {
    const [b, gross] = await Promise.all([read(E, "beam", [pid, BigInt(bid)]), read(E, "beamGross", [pid, BigInt(bid)])]);
    return { state: STATES[b.state], until: Number(b.p.until), marketMask: b.p.marketMask, budget: b.p.budget, levCap: b.p.levCap, gross, pending: b.pending };
  },
  beamSize: async (pid, bid, m) => (await read(E, "beamPosition", [pid, BigInt(bid), BigInt(m)])).size,
  async crystalRisk(pid) {
    const [[equity, im, mm], grossIm] = await Promise.all([read(E, "crystalRisk", [pid]), read(E, "grossMargin", [pid])]);
    return { equity, im, mm, grossIm };
  },
};

const plain = (v: unknown): any =>
  typeof v === "bigint" ? v.toString()
  : Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;

// trace_leaf also stores the trace when the beam's own agent signed its leaf (EIP-191 over the 32-byte leaf).
const toolList = tools.map((t) => t.name !== "trace_leaf" ? t : {
  ...t,
  description: "Hash of a decision trace for the epoch receipt root. Pass `signature` (agent key, EIP-191 over the leaf) to have it stored and included in the next on-chain root.",
  inputSchema: { type: "object", properties: { trace: { type: "object" }, signature: { type: "string", description: "0x… signature of the leaf by the beam's agent key" } }, required: ["trace"] },
});

async function traceLeaf(a: { trace: Trace; signature?: Hex }) {
  const leaf = leafOf(a.trace);
  if (!a.signature) return { leaf, stored: false };
  if (JSON.stringify(a.trace).length > MAX_TRACE_BYTES) return { leaf, stored: false, reason: "trace too large" };
  const signer = (await recoverMessageAddress({ message: { raw: leaf }, signature: a.signature })).toLowerCase();
  const b = await read(E, "beam", [BigInt(a.trace.crystal), BigInt(a.trace.beam)]);
  const agent = (b.p.agent as string).toLowerCase();
  if (signer !== agent || a.trace.agent.toLowerCase() !== agent) return { leaf, stored: false, reason: "signer is not this beam's agent" };
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return { leaf, stored: false, reason: "trace storage not configured" };
  const { error } = await createClient(url, key, { auth: { persistSession: false } }).from("traces").upsert(
    { leaf, crystal: a.trace.crystal, beam: a.trace.beam, agent, trace_json: a.trace },
    { onConflict: "leaf", ignoreDuplicates: true },
  );
  return error ? { leaf, stored: false, reason: "storage error" } : { leaf, stored: true };
}

function server() {
  const s = new Server({ name: "refractfi", version: "0.1.0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...toolList, listingTool, ...gymTools] }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const a = args as any;
      const out =
        name === "trace_leaf" ? await traceLeaf(a)
        : name.startsWith("gym_") ? await gymHandle(name, a)
        : name === "prepare_listing"
          ? (Number(a.perfFeeBps) > 3000 ? { ok: false, reason: "FeeTooHigh" }
            : !safeUri(a.uri) ? { ok: false, reason: "uri must be an https:// or ipfs:// link" }
            // Encode exactly the normalized value that was validated.
            : { ok: true, to: REGISTRY, data: encodeFunctionData({ abi: listingAbi, functionName: "list", args: [Number(a.perfFeeBps), safeUri(a.uri)!] }), value: "0" })
        : await handle(name, args, reader, E);
      return { content: [{ type: "text", text: JSON.stringify(plain(out)) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e instanceof Error ? e.message : e).replace(/https?:\/\/\S+/g, "[url]").slice(0, 300) }] };
    }
  });
  return s;
}

/** One server + transport per request (stateless mode). */
export async function fetchHandler(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server().connect(transport);
  return transport.handleRequest(request);
}

export default { fetch: fetchHandler };
