// trace-poster: every TRACE_EPOCH_SECS (default 1 h), takes the agent-signed traces not yet in an epoch, builds the
// sorted-pair Merkle root (kit SDK, matches TraceRoots.proves) and commits it on-chain as the next epoch.
// Leaves are sorted ascending before building, so any proof can be recomputed later from the epoch's leaves.
import { createClient } from "@supabase/supabase-js";
import { parseAbi, type Hex } from "viem";
import { buildTree } from "../../sdk/src/traces.js";
import { deploy, env } from "./config";
import { pub, scrub, sendOrReset, signer } from "./chain";

const ROOTS = deploy.contracts.TraceRoots.address as Hex;
const rootsAbi = parseAbi([
  "function lastEpoch() view returns (uint64)",
  "function commit(uint64 epoch, bytes32 root, uint32 leaves)",
  "function proves(uint64 epoch, bytes32 leaf, bytes32[] proof) view returns (bool)",
]);
const MAX_LEAVES = 5000;

export const status = { lastPoll: 0, epochs: 0, leaves: 0, lastErr: "" };
const db = () => createClient(env.need("SUPABASE_URL"), env.need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });

/** Commit one epoch from pending traces. Returns the epoch, or null when there was nothing to commit. */
export async function postEpoch(): Promise<{ epoch: bigint; root: Hex; leaves: Hex[] } | null> {
  const d = db();
  const { data, error } = await d.from("traces").select("leaf").is("epoch", null).order("leaf").limit(MAX_LEAVES);
  if (error) throw new Error(`traces: ${error.message}`);
  if (!data?.length) return null;
  const leaves = data.map((r) => r.leaf as Hex);
  const { root } = buildTree(leaves);
  const epoch = (await pub.readContract({ address: ROOTS, abi: rootsAbi, functionName: "lastEpoch" })) + 1n;
  const s = signer("POSTER_PK");
  const { request } = await pub.simulateContract({ account: s.account, address: ROOTS, abi: rootsAbi, functionName: "commit", args: [epoch, root, leaves.length] });
  const hash = await sendOrReset(s.account.address, () => s.wallet.writeContract(request));
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`commit reverted ${hash}`);
  const { error: e2 } = await d.from("traces").update({ epoch: Number(epoch) }).in("leaf", leaves);
  if (e2) throw new Error(`traces epoch: ${e2.message}`);
  console.log(`[traces] epoch ${epoch}: ${leaves.length} leaves, root ${root}, tx ${hash}`);
  return { epoch, root, leaves };
}

/** Merkle proof for a stored leaf, rebuilt from its epoch's leaves (same sort as postEpoch). */
export async function proofOf(leaf: Hex): Promise<{ epoch: bigint; proof: Hex[] }> {
  const d = db();
  const { data: row } = await d.from("traces").select("epoch").eq("leaf", leaf).maybeSingle();
  if (!row?.epoch) throw new Error("leaf not committed yet");
  const { data } = await d.from("traces").select("leaf").eq("epoch", row.epoch).order("leaf");
  const leaves = (data ?? []).map((r) => r.leaf as Hex);
  return { epoch: BigInt(row.epoch), proof: buildTree(leaves).proofs[leaves.indexOf(leaf)] };
}

export const provesOnChain = (epoch: bigint, leaf: Hex, proof: Hex[]) =>
  pub.readContract({ address: ROOTS, abi: rootsAbi, functionName: "proves", args: [epoch, leaf, proof] });

export async function startTracePoster() {
  const every = Number(env.get("TRACE_EPOCH_SECS") ?? 3600) * 1000;
  console.log(`[traces] committing an epoch every ${every / 1000}s when there are new traces`);
  for (;;) {
    try {
      const out = await postEpoch();
      if (out) { status.epochs++; status.leaves += out.leaves.length; }
      status.lastPoll = Date.now();
    } catch (e) {
      status.lastErr = scrub(e);
      console.error(`[traces] ${status.lastErr}`);
    }
    await Bun.sleep(every);
  }
}
