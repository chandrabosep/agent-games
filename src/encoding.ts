import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Decision, TaskInput } from './types.js';

/**
 * How Task values become circuit field elements. The platform doesn't document it.
 * Hex values are integers reduced mod p. For `task_id`, practice accepts `keccak`, but
 * competition Proofs made with it were not credited (Rounds 1 and 3), so TASK_ID_ENCODING
 * can list several candidates for the Encoding trial (src/encodingTrial.ts) to settle.
 */
export const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const TASK_ID_ENCODINGS = ['keccak', 'keccak-shr8', 'sha256', 'ascii', 'hex-digits', 'uuid-tail'] as const;
export type TaskIdEncoding = (typeof TASK_ID_ENCODINGS)[number];

const mod = (x: bigint) => ((x % BN254_P) + BN254_P) % BN254_P;

/** A UUID (dashes optional) at the end of a `task_id`, e.g. `task_R03_16e835e2-9c68-4307-30da-4b8a25ebd319`. */
const UUID_TAIL = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Parses TASK_ID_ENCODING: one name, or a comma-separated list of candidates in trial order. */
export function parseTaskIdEncodings(value: string): TaskIdEncoding[] {
  const names = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const unknown = names.filter((n) => !(TASK_ID_ENCODINGS as readonly string[]).includes(n));
  if (names.length === 0 || unknown.length > 0 || new Set(names).size !== names.length) {
    throw new Error(`TASK_ID_ENCODING must be a list of distinct names from: ${TASK_ID_ENCODINGS.join(', ')}`);
  }
  return names as TaskIdEncoding[];
}

export function taskIdToField(taskId: string, encoding: TaskIdEncoding): bigint {
  switch (encoding) {
    case 'keccak':
      return mod(BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(taskId)))}`));
    case 'keccak-shr8':
      // The hash's top 31 bytes: always below p, so no reduction.
      return BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(taskId)))}`) >> 8n;
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
    case 'uuid-tail': {
      // The trailing UUID as a 128-bit integer, the way Steal the VFY encodes a matchId.
      const m = UUID_TAIL.exec(taskId);
      return m ? BigInt(`0x${m[0].replace(/-/g, '')}`) : taskIdToField(taskId, 'keccak');
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
