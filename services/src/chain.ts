// Shared chain access for keepers: clients per key, engine ABI, and simulate-then-send.
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http, parseAbi, type Hex,
} from "viem";
import { createNonceManager, privateKeyToAccount, type NonceManager, type NonceManagerSource } from "viem/accounts";
import { getTransactionCount } from "viem/actions";
import { chain, deploy, pk } from "./config";

export const engine = deploy.contracts.RefractEngine.address as Hex;

export const engineAbi = parseAbi([
  "function settleWindow(uint256 m, uint64 w)",
  "function voidWindow(uint256 m, uint64 w)",
  "function enforce(uint256 pid, uint256 bid)",
  "function liquidate(uint256 pid)",
  "function crystalCount() view returns (uint256)",
  "function crystals(uint256) view returns (address owner, uint8 beamCount, uint32 openMask, int256 collateral, int256 netDeposits, int256 perfPaid, int256 liqPaid, int256 badDebt, int256 pending)",
  "function windowDone(uint256 m, uint64 w) view returns (bool)",
  "event Queued(uint256 indexed market, uint64 indexed window, uint256 crystal, uint256 beam, int256 size)",
  "event WindowSettled(uint256 indexed market, uint64 indexed window, int256 matched, int256 residual, bool residualFilled, int256 mark)",
  "error AlreadySettled()", "error WindowOpen()", "error NothingToEnforce()", "error BeamClosed()",
  "error NotLiquidatable()", "error StalePrice()", "error NoPriceAt(bytes32 feedId, uint64 ts)",
]);

export const pub = createPublicClient({ chain, transport: http() });

// Nonces. viem's manager remembers the last nonce it handed out and never goes below it, even after reset(), so one
// send that never lands (out of gas, rejected) pins every later send at "nonce higher than expected" until the process
// restarts (13 h of frozen prices on Nov 16-17). Each key gets a manager whose reset() throws all of that away and
// re-reads the chain's pending nonce.
// Only a failed send resets (never quote/log/receipt errors); at worst one overlapping send fails once and is retried.
// ponytail: no per-key send queue; add one if a keeper ever sends many txs concurrently.
const pendingNonce: NonceManagerSource = {
  get: ({ address, client }) => getTransactionCount(client, { address, blockTag: "pending" }),
  set() {},
};
const managers = new Map<string, NonceManager>();
export function resettableNonces(source: NonceManagerSource = pendingNonce): NonceManager {
  let inner = createNonceManager({ source });
  return {
    consume: (p) => inner.consume(p), increment: (p) => inner.increment(p), get: (p) => inner.get(p),
    reset: () => { inner = createNonceManager({ source }); },
  };
}
/** A signing account whose nonces `resetNonce` can really reset. One manager per address, shared by all users. */
export function keyAccount(key: Hex) {
  const address = privateKeyToAccount(key).address.toLowerCase();
  if (!managers.has(address)) managers.set(address, resettableNonces());
  return privateKeyToAccount(key, { nonceManager: managers.get(address)! });
}
export const resetNonce = (address: Hex) => managers.get(address.toLowerCase())?.reset({ address, chainId: chain.id });
export const sendOrReset = <T>(address: Hex, send: () => Promise<T>) =>
  send().catch((e) => { resetNonce(address); throw e; });

export function signer(keyEnv: string) {
  const account = keyAccount(pk(keyEnv));
  return { account, wallet: createWalletClient({ chain, account, transport: http() }) };
}

/** Revert reason name if the error is a contract revert ("NothingToEnforce", ...), else null. */
export function revertName(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? (r.data?.errorName ?? r.signature ?? "reverted") : null;
}

export const scrub = (e: unknown) => String(e).replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);

type Fn = "settleWindow" | "voidWindow" | "enforce" | "liquidate";

/**
 * Simulate the call; only if the engine would accept it, send it and wait for the receipt.
 * Returns the tx hash, or the revert name when the engine refuses (nothing is sent then).
 */
export async function simulateThenSend(s: ReturnType<typeof signer>, fn: Fn, args: readonly bigint[]) {
  try {
    const { request } = await pub.simulateContract({
      account: s.account, address: engine, abi: engineAbi, functionName: fn, args: args as never,
    });
    const hash = await sendOrReset(s.account.address, () => s.wallet.writeContract(request));
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (r.status !== "success") throw new Error(`${fn} reverted on-chain ${hash}`);
    return { hash };
  } catch (e) {
    const name = revertName(e);
    if (name) return { refused: name };
    throw e;
  }
}

export type KeeperStatus = { lastPoll: number; sent: number; lastTx: string; lastErr: string };
export const newStatus = (): KeeperStatus => ({ lastPoll: 0, sent: 0, lastTx: "", lastErr: "" });
