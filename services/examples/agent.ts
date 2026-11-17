// Reference agent (M5): trades through the RefractFi MCP server, signs with its beam key, records a signed trace,
// and checks the trace's proof against TraceRoots on-chain.
// Run from services/: MCP_URL=https://refractfi.org/api/mcp bun --env-file=../.env examples/agent.ts
// (MCP_URL defaults to the local dev server: bun --env-file=../.env src/mcp-dev.ts)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWalletClient, encodeFunctionData, http, parseAbi, parseUnits, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import type { Trace } from "../../sdk/src/traces.js";
import { chain, deploy } from "../src/config";
import { pub, revertName } from "../src/chain";
import { postEpoch, proofOf, provesOnChain } from "../src/tracePoster";

const E = deploy.contracts.RefractEngine.address as Hex;
const USDG = deploy.contracts.MockUSDG.address as Hex;
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8790/";
const abi = parseAbi([
  "function mint(address to, uint256 amt)",
  "function approve(address s, uint256 amt) returns (bool)",
  "function openCrystal() returns (uint256)",
  "function deposit(uint256 pid, uint256 amount)",
  "function withdraw(uint256 pid, uint256 amount)",
  "function flatten(uint256 pid)",
  "function setBeam(uint256 pid, uint256 bid, (address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap) p)",
  "function trade(uint256 pid, uint256 bid, uint256 m, int256 size, int256 limitPrice)",
  "function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)",
  "event CrystalOpened(uint256 indexed crystal, address indexed owner)",
  "error OverBeamCap()", "error InsufficientMargin()", "error StalePrice()",
]);
const owner = privateKeyToAccount(process.env.DEPLOYER_PK as Hex, { nonceManager });
const agent = privateKeyToAccount(process.env.AGENT_PK as Hex, { nonceManager });
const ownerW = createWalletClient({ chain, account: owner, transport: http() });
const agentW = createWalletClient({ chain, account: agent, transport: http() });

async function ownerSend(address: Hex, functionName: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: owner, address, abi, functionName: functionName as never, args: args as never });
  const r = await pub.waitForTransactionReceipt({ hash: await ownerW.writeContract(request) });
  if (r.status !== "success") throw new Error(`${functionName} failed`);
  return r;
}

const results: string[] = [];
const ok = (cond: boolean, msg: string) => { results.push(`${cond ? "PASS" : "FAIL"} ${msg}`); console.log(results.at(-1)); };

// --- Owner sets up a Crystal and a Beam for this agent (the dashboard does this in M6) ---
const dep = parseUnits("1000", 6);
await ownerSend(USDG, "mint", [owner.address, dep]);
await ownerSend(USDG, "approve", [E, dep]);
const opened = await ownerSend(E, "openCrystal", []);
const pid = (await pub.getContractEvents({ address: E, abi, eventName: "CrystalOpened", fromBlock: opened.blockNumber, toBlock: opened.blockNumber }))[0].args.crystal!;
await ownerSend(E, "deposit", [pid, dep]);
await ownerSend(E, "setBeam", [pid, 0n, { agent: agent.address, until: BigInt(Math.floor(Date.now() / 1000) + 86400), marketMask: 3, softBps: 500, hardBps: 750, perfFeeBps: 1000, budget: parseUnits("1000", 18), levCap: parseUnits("5", 18) }]);
console.log(`crystal ${pid}: beam 0 -> agent ${agent.address} ($1,000 budget, 5x cap)`);

// --- Agent: everything below goes through MCP ---
const mcp = new Client({ name: "refractfi-reference-agent", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const listed = (await mcp.listTools()).tools.map((t) => t.name);
ok(listed.length === 7, `MCP at ${MCP_URL} lists ${listed.length} tools`);

const size = parseUnits("0.01", 18).toString(); // 0.01 BTC
const q = await call("quote_route", { market: 0, size });
console.log(`   quote: lens price $${(Number(q.lensPrice) / 1e18).toFixed(2)}, cost now $${(Number(q.immediateCost) / 1e18).toFixed(4)}`);
const chk = await call("check_order", { crystal: pid.toString(), beam: 0, market: 0, size, route: "lens" });
ok(chk.ok === true, `check_order passes for 0.01 BTC`);

const prep = await call("prepare_trade", { crystal: pid.toString(), beam: 0, market: 0, size });
const hash = await agentW.sendTransaction({ to: prep.to, data: prep.data });
const rcpt = await pub.waitForTransactionReceipt({ hash });
ok(rcpt.status === "success", `agent signed and sent the MCP-prepared trade: ${hash}`);

// Over the beam cap: MCP refuses with the engine's own error name, and the engine agrees.
const big = parseUnits("1", 18); // 1 BTC ≈ $60k+ > $1,000 × 5x
const refused = await call("prepare_trade", { crystal: pid.toString(), beam: 0, market: 0, size: big.toString() });
let engineSays = "accepted";
try {
  await pub.simulateContract({ account: agent, address: E, abi, functionName: "trade", args: [pid, 0n, 0n, big, 0n] });
} catch (e) { engineSays = revertName(e) ?? "reverted"; }
ok(refused.ok === false && refused.reason === "OverBeamCap" && engineSays === "OverBeamCap",
  `over-cap order: MCP says ${refused.reason}, engine says ${engineSays}`);

// Decision trace, signed by the agent key, stored by MCP, committed on-chain, proven.
const [equity] = await pub.readContract({ address: E, abi, functionName: "crystalRisk", args: [pid] });
const trace: Trace = {
  crystal: pid.toString(), beam: 0, agent: agent.address.toLowerCase(), ts: Math.floor(Date.now() / 1000),
  saw: { market: 0, mark: q.lensPrice, skew: "0", equity: equity.toString(), hwm: parseUnits("1000", 18).toString() },
  proposed: { route: "lens", size }, gate: { ok: true }, tx: hash,
};
const { leaf } = await call("trace_leaf", { trace });
const signature = await agent.signMessage({ message: { raw: leaf } });
const stored = await call("trace_leaf", { trace, signature });
ok(stored.stored === true, `signed trace stored (leaf ${leaf.slice(0, 10)}…)`);
const forged = await call("trace_leaf", { trace: { ...trace, ts: trace.ts + 1 }, signature: await owner.signMessage({ message: { raw: leaf } }) });
ok(forged.stored === false, `trace signed by a non-agent key is refused (${forged.reason})`);

const epoch = await postEpoch();
const { epoch: e, proof } = await proofOf(leaf);
ok(!!epoch && (await provesOnChain(e, leaf, proof)), `TraceRoots.proves(epoch ${e}, leaf) is true on-chain`);

// Clean up: owner flattens and withdraws.
await ownerSend(E, "flatten", [pid]);
const [eq2] = await pub.readContract({ address: E, abi, functionName: "crystalRisk", args: [pid] });
await ownerSend(E, "withdraw", [pid, eq2 / 10n ** 12n]);
await mcp.close();
console.log(results.every((x) => x.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
