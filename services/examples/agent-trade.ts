// The test agent (AGENT_PK) trades in someone's Beam: lets an owner see a live fill on the dashboard.
//   bun --env-file=../.env examples/agent-trade.ts <crystal> <beam> <market> <size>   (size in units, negative = short)
//   e.g. examples/agent-trade.ts 14 0 0 0.01   -> long 0.01 BTC in crystal 14, beam 1
import { createWalletClient, http, parseAbi, parseUnits, type Hex } from "viem";
import { chain } from "../src/config";
import { engine, keyAccount, pub } from "../src/chain";

const [pid, bid, m, size] = process.argv.slice(2);
if (!size) throw new Error("usage: agent-trade.ts <crystal> <beam> <market> <size>");
const abi = parseAbi([
  "function trade(uint256 pid, uint256 bid, uint256 m, int256 size, int256 limitPrice)",
  "function crystalRisk(uint256 pid) view returns (int256 equity, int256 im, int256 mm)",
  "event Filled(uint256 indexed crystal, uint256 indexed beam, uint256 indexed market, int256 size, int256 price, int256 fee, bool crossed)",
]);
const account = keyAccount(process.env.AGENT_PK as Hex);
const { request } = await pub.simulateContract({ account, address: engine, abi, functionName: "trade", args: [BigInt(pid), BigInt(bid), BigInt(m), parseUnits(size, 18), 0n] });
const hash = await createWalletClient({ chain, account, transport: http() }).writeContract(request);
const r = await pub.waitForTransactionReceipt({ hash });
const fill = (await pub.getContractEvents({ address: engine, abi, eventName: "Filled", fromBlock: r.blockNumber, toBlock: r.blockNumber })).find((l) => l.transactionHash === hash);
const [eq, im, mm] = await pub.readContract({ address: engine, abi, functionName: "crystalRisk", args: [BigInt(pid)] });
const usd = (x: bigint) => (Number(x) / 1e18).toFixed(2);
console.log(r.status, hash);
if (fill) console.log(`filled ${Number(fill.args.size) / 1e18} @ $${usd(fill.args.price!)}, fee $${usd(fill.args.fee!)}${fill.args.crossed ? " (crossed)" : ""}`);
else console.log("queued for the crossing window (settles within ~5 s)");
console.log(`crystal ${pid}: equity $${usd(eq)}, initial margin $${usd(im)}, maintenance $${usd(mm)}`);
