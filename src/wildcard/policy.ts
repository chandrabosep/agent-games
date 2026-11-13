// Policy Vault (Wildcard entry): the payment Policy and the exact rules of
// wildcard/circuits/policy_payment.circom, mirrored so the agent knows before proving
// whether the circuit will accept a payment. Tested against the circuit.
import { poseidon1, poseidon2, poseidon4 } from 'poseidon-lite';

/** Allowlist tree depth in the circuit: up to 256 recipients. */
export const TREE_DEPTH = 8;
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const U160 = (1n << 160n) - 1n;

/** Private. Only its commitment goes on chain. */
export interface Policy {
  /** Largest single payment, in the token's smallest unit. */
  maxPerTx: bigint;
  /** Unix seconds. No payment may have a deadline after this. */
  policyExpiry: bigint;
  /** Recipient addresses as integers. */
  allowlist: bigint[];
  /** Random, so the commitment can't be brute-forced from a guessed policy. */
  salt: bigint;
}

/** Public. Every field is a public input of the proof, and the vault rebuilds them on chain. */
export interface Payment {
  recipient: bigint;
  amount: bigint;
  nonce: bigint;
  /** Unix seconds. The vault refuses to pay after this. */
  validUntil: bigint;
  /** Vault contract address as an integer. */
  vault: bigint;
  chainId: bigint;
}

export type PolicyRefusal = 'NOT_ALLOWLISTED' | 'OVER_LIMIT' | 'ZERO_AMOUNT' | 'AFTER_POLICY_EXPIRY' | 'OUT_OF_RANGE';

export function addressToBigint(address: string): bigint {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an address: ${address}`);
  return BigInt(address);
}

export function bigintToAddress(value: bigint): string {
  return '0x' + value.toString(16).padStart(40, '0');
}

/** Empty slots hold 0, which is never the hash of a real recipient. */
function leaves(policy: Policy): bigint[] {
  const size = 1 << TREE_DEPTH;
  if (policy.allowlist.length > size) throw new Error(`allowlist holds at most ${size} recipients`);
  if (new Set(policy.allowlist).size !== policy.allowlist.length) throw new Error('allowlist has duplicates');
  const out = policy.allowlist.map((a) => {
    if (a < 0n || a > U160) throw new Error('allowlist entry is not an address');
    return poseidon1([a]);
  });
  while (out.length < size) out.push(0n);
  return out;
}

function levels(policy: Policy): bigint[][] {
  const all = [leaves(policy)];
  for (let d = 0; d < TREE_DEPTH; d++) {
    const prev = all[d];
    const next: bigint[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(poseidon2([prev[i], prev[i + 1]]));
    all.push(next);
  }
  return all;
}

export function allowlistRoot(policy: Policy): bigint {
  return levels(policy)[TREE_DEPTH][0];
}

/** What the vault stores. */
export function policyCommitment(policy: Policy): bigint {
  return poseidon4([policy.maxPerTx, policy.policyExpiry, allowlistRoot(policy), policy.salt]);
}

/** The circuit's rules, in order. null means the circuit will accept the payment. */
export function refusal(policy: Policy, p: Payment): PolicyRefusal | null {
  if (p.recipient < 0n || p.recipient > U160) return 'OUT_OF_RANGE';
  if (p.amount < 0n || p.amount > U128 || policy.maxPerTx < 0n || policy.maxPerTx > U128) return 'OUT_OF_RANGE';
  if (p.validUntil < 0n || p.validUntil > U64 || policy.policyExpiry < 0n || policy.policyExpiry > U64) return 'OUT_OF_RANGE';
  if (p.amount === 0n) return 'ZERO_AMOUNT';
  if (p.amount > policy.maxPerTx) return 'OVER_LIMIT';
  if (p.validUntil > policy.policyExpiry) return 'AFTER_POLICY_EXPIRY';
  if (!policy.allowlist.includes(p.recipient)) return 'NOT_ALLOWLISTED';
  return null;
}

/** Public signals in the circuit's order; the vault builds the same list. */
export function publicSignals(policy: Policy, p: Payment): bigint[] {
  return [policyCommitment(policy), p.recipient, p.amount, p.nonce, p.validUntil, p.vault, p.chainId];
}

/** Circuit input. Throws if the recipient isn't on the allowlist (no Merkle path exists). */
export function circuitInput(policy: Policy, p: Payment): Record<string, string | string[]> {
  const index = policy.allowlist.indexOf(p.recipient);
  if (index < 0) throw new Error('recipient is not on the allowlist');
  const lv = levels(policy);
  const pathElements: string[] = [];
  const pathIndices: string[] = [];
  let i = index;
  for (let d = 0; d < TREE_DEPTH; d++) {
    pathElements.push(lv[d][i ^ 1].toString());
    pathIndices.push(String(i & 1));
    i >>= 1;
  }
  return {
    policyCommitment: policyCommitment(policy).toString(),
    recipient: p.recipient.toString(),
    amount: p.amount.toString(),
    nonce: p.nonce.toString(),
    validUntil: p.validUntil.toString(),
    vault: p.vault.toString(),
    chainId: p.chainId.toString(),
    maxPerTx: policy.maxPerTx.toString(),
    policyExpiry: policy.policyExpiry.toString(),
    salt: policy.salt.toString(),
    pathElements,
    pathIndices,
  };
}

/** Policy from JSON (env): {maxPerTx, policyExpiry, allowlist: [address], salt}, numbers as strings. */
export function parsePolicy(json: string): Policy {
  const raw = JSON.parse(json) as { maxPerTx: string; policyExpiry: string; allowlist: string[]; salt: string };
  return {
    maxPerTx: BigInt(raw.maxPerTx),
    policyExpiry: BigInt(raw.policyExpiry),
    allowlist: raw.allowlist.map(addressToBigint),
    salt: BigInt(raw.salt),
  };
}
