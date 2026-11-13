import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Decision, TaskInput } from './types.js';

/**
 * How Task values become circuit field elements. UNCONFIRMED: the platform
 * doesn't document it. Best guess: hex values as integers reduced mod p, and
 * `task_id` hashed with keccak256 then reduced. Settle it with practice tasks;
 * switch schemes with TASK_ID_ENCODING without code changes.
 */
export const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const TASK_ID_ENCODINGS = ['keccak', 'sha256', 'ascii', 'hex-digits'] as const;
export type TaskIdEncoding = (typeof TASK_ID_ENCODINGS)[number];

const mod = (x: bigint) => ((x % BN254_P) + BN254_P) % BN254_P;

export function taskIdToField(taskId: string, encoding: TaskIdEncoding): bigint {
  switch (encoding) {
    case 'keccak':
      return mod(BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(taskId)))}`));
    case 'sha256':
      return mod(BigInt(`0x${bytesToHex(sha256(utf8ToBytes(taskId)))}`));
    case 'ascii': {
      const bytes = utf8ToBytes(taskId);
      return bytes.length === 0 ? 0n : mod(BigInt(`0x${bytesToHex(bytes)}`));
    }
    case 'hex-digits': {
      // e.g. "gk_24_9d1": every hex-looking chunk after the prefix, concatenated.
      const digits = taskId.replace(/^gk_/, '').replace(/[^0-9a-fA-F]/g, '');
      return digits === '' ? 0n : mod(BigInt(`0x${digits}`));
    }
  }
}

/** Circuit input object for the gatekeeper circuit (all values as decimal strings). */
export function toCircuitInputs(
  input: TaskInput,
  taskId: string,
  decision: Decision,
  salt: bigint,
  encoding: TaskIdEncoding,
): Record<string, string> {
  const f = (x: bigint) => mod(x).toString();
  return {
    minimum: f(input.minimum),
    publicBalance: f(input.publicBalance),
    amount: f(input.amount),
    maxTransfer: f(input.maxTransfer),
    recipient: f(input.recipient),
    conditionRecipient: f(input.conditionRecipient),
    expiryBlock: f(input.expiryBlock),
    currentBlock: f(input.currentBlock),
    taskId: f(taskIdToField(taskId, encoding)),
    salt: f(salt),
    decision: decision === 'APPROVE' ? '1' : '0',
    registeredVkHash: f(input.registeredVk),
    proofVkHash: f(input.proofVk),
  };
}
