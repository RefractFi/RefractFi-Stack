// M9 live check: an agent lists on Spectrum, runs a paper season through MCP, gets promoted, and is hired on-chain.
// Run from services/: MCP_URL=https://refractfi.org/api/mcp bun --env-file=../.env examples/m9-spectrum.ts
// Uses a 2-minute test season (inserted directly) so the check doesn't wait a day.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { createWalletClient, http, keccak256, parseAbi, parseUnits, toBytes, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { canonical } from "../../sdk/src/traces.js";
import { chain, deploy } from "../src/config";
import { pub } from "../src/chain";

const E = deploy.contracts.RefractEngine.address as Hex;
const USDG = deploy.contracts.MockUSDG.address as Hex;
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8790/";
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const abi = parseAbi([
  "function mint(address to, uint256 amt)", "function approve(address s, uint256 amt) returns (bool)",
  "function openCrystal() returns (uint256)", "function deposit(uint256 pid, uint256 amount)",
  "function setBeam(uint256 pid, uint256 bid, (address agent, uint64 until, uint32 marketMask, uint16 softBps, uint16 hardBps, uint16 perfFeeBps, int256 budget, int256 levCap) p)",
  "event CrystalOpened(uint256 indexed crystal, address indexed owner)",
]);
const owner = privateKeyToAccount(process.env.DEPLOYER_PK as Hex, { nonceManager });
const agent = privateKeyToAccount(process.env.AGENT_PK as Hex, { nonceManager });
const agentLc = agent.address.toLowerCase();
async function ownerSend(address: Hex, fn: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: owner, address, abi, functionName: fn as never, args: args as never });
  const r = await pub.waitForTransactionReceipt({ hash: await createWalletClient({ chain, account: owner, transport: http() }).writeContract(request) });
  if (r.status !== "success") throw new Error(`${fn} failed`);
  return r;
}
const results: string[] = [];
const ok = (c: boolean, m: string) => { results.push(`${c ? "PASS" : "FAIL"} ${m}`); console.log(results.at(-1)); };
const wait = async (what: string, f: () => Promise<boolean>, secs = 150) => { for (let t = 0; t < secs; t += 5) { if (await f()) return true; await Bun.sleep(5000); } console.log(`   timed out waiting for ${what}`); return false; };

const mcp = new Client({ name: "m9-check", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await mcp.callTool({ name, arguments: args });
  return { error: r.isError ? r.content[0].text : null, out: r.isError ? null : JSON.parse(r.content[0].text) };
};
const signed = async (action: Record<string, unknown>) => ({ ...action, signature: await agent.signMessage({ message: { raw: keccak256(toBytes(canonical(action))) } }) });

// 1. List on Spectrum (the agent sends the MCP-prepared calldata itself).
const lst = await call("prepare_listing", { perfFeeBps: 1500, uri: "https://refractfi.org/protocol/ecosystem" });
const hash = await createWalletClient({ chain, account: agent, transport: http() }).sendTransaction({ to: lst.out.to, data: lst.out.data });
await pub.waitForTransactionReceipt({ hash });
ok(await wait("indexed listing", async () => !!(await db.from("spectrum").select("agent").eq("agent", agentLc).eq("active", true).maybeSingle()).data, 60), "agent listed on Spectrum (indexed)");

// 2. Short test season, join, three paper orders through the engine's rules.
const { data: season } = await db.from("gym_seasons").insert({ ends_at: new Date(Date.now() + 120_000).toISOString() }).select("id").single();
const sid = season!.id;
const ts = () => Math.floor(Date.now() / 1000);
const join = await call("gym_join", await signed({ action: "gym_join", agent: agent.address, season: sid, ts: ts() }));
ok(join.out?.joined === true, `joined paper season ${sid}`);
const W = (x: number) => parseUnits(String(x), 18).toString();
const o1 = await signed({ action: "gym_order", agent: agent.address, season: sid, market: 0, size: W(0.002), ts: ts() });
const r1 = await call("gym_order", o1);
const r2 = await call("gym_order", await signed({ action: "gym_order", agent: agent.address, season: sid, market: 1, size: W(0.05), ts: ts() }));
const r3 = await call("gym_order", await signed({ action: "gym_order", agent: agent.address, season: sid, market: 0, size: W(-0.001), ts: ts() }));
ok([r1, r2, r3].every((r) => r.out?.ok === true), `3 paper orders filled at live marks (${[r1, r2, r3].map((r) => r.out?.ok ? "ok" : r.error ?? r.out?.reason).join(", ")})`);
const replay = await call("gym_order", o1);
ok(!!replay.error && /already used|stale/.test(replay.error), `replayed signed order refused (${replay.error})`);
const over = await call("gym_order", await signed({ action: "gym_order", agent: agent.address, season: sid, market: 0, size: W(1), ts: ts() }));
ok(over.out?.ok === false && over.out?.reason === "OverBeamCap", `over-cap paper order refused by the engine's rule: ${over.out?.reason}`);

// 3. Season ends -> the worker promotes the agent.
console.log("   waiting for the season to end and the worker to finalize it…");
ok(await wait("promotion", async () => !!(await db.from("gym_entries").select("promoted").eq("season", sid).eq("agent", agentLc).eq("finished", true).eq("promoted", true).maybeSingle()).data, 240), "agent promoted after finishing the season inside its rules");
ok(!!(await db.from("spectrum").select("promoted").eq("agent", agentLc).eq("promoted", true).maybeSingle()).data, "Spectrum shows the promotion");

// 4. Hire: the owner opens a Beam for the agent; Spectrum's record picks it up from chain.
const dep = parseUnits("1000", 6);
await ownerSend(USDG, "mint", [owner.address, dep]);
await ownerSend(USDG, "approve", [E, dep]);
const r = await ownerSend(E, "openCrystal", []);
const pid = (await pub.getContractEvents({ address: E, abi, eventName: "CrystalOpened", fromBlock: r.blockNumber, toBlock: r.blockNumber }))[0].args.crystal!;
await ownerSend(E, "deposit", [pid, dep]);
await ownerSend(E, "setBeam", [pid, 0n, { agent: agent.address, until: BigInt(ts() + 7 * 86400), marketMask: 3, softBps: 500, hardBps: 750, perfFeeBps: 1500, budget: parseUnits("1000", 18), levCap: parseUnits("5", 18) }]);
ok(await wait("Spectrum record", async () => ((await db.from("spectrum").select("beams").eq("agent", agentLc).maybeSingle()).data?.beams ?? 0) >= 1, 120), `hired into crystal ${pid}: Spectrum record counts the on-chain beam`);

await mcp.close();
console.log(results.every((x) => x.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
