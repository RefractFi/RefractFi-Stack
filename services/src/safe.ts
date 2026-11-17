// Admin multisig: a Safe v1.4.1 (canonical deployment, already on chain 46630) is the engine's admin.
// Owners: the owner's wallet, DEPLOYER_PK, BACKUP_PK; threshold 2. The two .env keys sign together here,
// so the operator can act alone on testnet; on mainnet they become hardware wallets.
//   bun --env-file=../.env src/safe.ts setup                                  create the Safe, hand it the engine admin
//   bun --env-file=../.env src/safe.ts call "pauseOpens(bool)" false        any admin call on the engine (integers as plain digits)
import { readFileSync, writeFileSync } from "node:fs";
import { concat, encodeFunctionData, type AbiFunction, parseAbi, parseAbiItem, zeroAddress, type Hex } from "viem";
import { deploy, pk } from "./config";
import { engine, keyAccount, pub, signer } from "./chain";

const FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FALLBACK = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const OWNER_WALLET = "0x071aabef35529ba679a69124464aa27315374614"; // crystal 14's owner (dashboard wallet)

const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function admin() view returns (address)",
  "function setAdmin(address a)",
]);
const deployer = signer("DEPLOYER_PK");
const safeAddr = () => (deploy as { adminSafe?: { address: Hex } }).adminSafe?.address;

async function send(address: Hex, functionName: string, args: readonly unknown[]) {
  const { request, result } = await pub.simulateContract({ account: deployer.account, address, abi: safeAbi, functionName, args } as never);
  const hash = await deployer.wallet.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return { hash, result };
}

/** Run `data` on `to` from the Safe, signed by the two .env owners. */
export async function safeExec(to: Hex, data: Hex) {
  const safe = safeAddr();
  if (!safe) throw new Error("no adminSafe in deployments/testnet.json; run setup first");
  const nonce = await pub.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const tx = [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const;
  const hash = await pub.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [...tx, nonce] });
  // Safe wants signatures sorted by owner address; a raw ECDSA signature over the hash (v = 27/28) is type "EOA".
  const owners = [keyAccount(pk("DEPLOYER_PK")), keyAccount(pk("BACKUP_PK"))]
    .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const signatures = concat(await Promise.all(owners.map((o) => o.sign({ hash }))));
  return send(safe, "execTransaction", [...tx, signatures]);
}

async function setup() {
  if (safeAddr()) throw new Error(`adminSafe already set: ${safeAddr()}`);
  const owners = [OWNER_WALLET, deployer.account.address, keyAccount(pk("BACKUP_PK")).address] as Hex[];
  const init = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [owners, 2n, zeroAddress, "0x", FALLBACK, zeroAddress, 0n, zeroAddress] });
  const { result } = await send(FACTORY, "createProxyWithNonce", [SAFE_L2, init, BigInt(Date.now())]);
  const safe = result as Hex;
  const [got, threshold] = await Promise.all([
    pub.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    pub.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
  ]);
  console.log(`Safe ${safe}: ${threshold}-of-${got.length}`, got.join(", "));
  const file = new URL("../../deployments/testnet.json", import.meta.url);
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.adminSafe = { address: safe, owners: got, threshold: Number(threshold), note: "Engine admin (Safe v1.4.1 L2). Guardian stays a single key: it can only pause opens." };
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  const { hash } = await send(engine, "setAdmin", [safe]);
  console.log("engine admin ->", await pub.readContract({ address: engine, abi: safeAbi, functionName: "admin" }), hash);
}

if (import.meta.main) {
  const [cmd, sig, ...args] = process.argv.slice(2);
  if (cmd === "setup") await setup();
  else if (cmd === "call" && sig) {
    const item = parseAbiItem(`function ${sig}`) as AbiFunction;
    const t = (i: number) => item.inputs[i].type;
    const data = encodeFunctionData({ abi: [item], args: args.map((a, i) => (/int/.test(t(i)) ? BigInt(a) : t(i) === "bool" ? a === "true" : a)) as never });
    console.log(await safeExec(engine, data));
  } else console.log('usage: safe.ts setup | safe.ts call "fn(types)" args...');
}
