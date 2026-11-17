import { keccak256, toBytes, concat, type Hex } from "viem";

/** Canonical JSON: sorted keys, bigint as decimal strings, no whitespace. */
export function canonical(v: unknown): string {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export interface Trace {
  crystal: string;
  beam: number;
  agent: string;
  ts: number;
  saw: { market: number; mark: string; skew: string; equity: string; hwm: string };
  proposed: { route: "lens" | "cross"; size: string; limit?: string; maxSlipBps?: number };
  gate: { ok: boolean; reason?: string };
  tx?: string;
}

export const leafOf = (t: Trace): Hex => keccak256(toBytes(canonical(t)));

const pair = (a: Hex, b: Hex): Hex => (a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** Sorted-pair Merkle tree (OpenZeppelin MerkleProof convention, as TraceRoots.proves expects). */
export function buildTree(leaves: Hex[]): { root: Hex; proofs: Hex[][] } {
  if (leaves.length === 0) throw new Error("no leaves");
  const proofs: Hex[][] = leaves.map(() => []);
  let level = leaves.map((h, i) => ({ h, idx: [i] }));
  while (level.length > 1) {
    const next: { h: Hex; idx: number[] }[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (!b) {
        next.push(a);
        continue;
      }
      a.idx.forEach((j) => proofs[j].push(b.h));
      b.idx.forEach((j) => proofs[j].push(a.h));
      next.push({ h: pair(a.h, b.h), idx: [...a.idx, ...b.idx] });
    }
    level = next;
  }
  return { root: level[0].h, proofs };
}

export function verify(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  return proof.reduce((h, p) => pair(h, p), leaf).toLowerCase() === root.toLowerCase();
}
