import type { Mode, TaskInput } from './types.js';

export class MalformedInput extends Error {}

const DECIMAL = /^[0-9]+$/;
const HEX = /^(0x)?[0-9a-fA-F]+$/;

/** Non-negative integer given as a JSON number or a decimal string. */
function uint(value: unknown, field: string): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && DECIMAL.test(value.trim())) return BigInt(value.trim());
  throw new MalformedInput(`${field} is not a non-negative integer`);
}

/** Hex string (with or without 0x, any case) as its integer value. */
function hex(value: unknown, field: string): bigint {
  if (typeof value === 'string') {
    const v = value.trim();
    if (HEX.test(v)) return BigInt(v.startsWith('0x') || v.startsWith('0X') ? v : `0x${v}`);
  }
  throw new MalformedInput(`${field} is not a hex string`);
}

export function parseTaskInput(raw: unknown): TaskInput {
  if (typeof raw !== 'object' || raw === null) throw new MalformedInput('input is not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.proof_tx !== 'string' || r.proof_tx.trim() === '') {
    throw new MalformedInput('proof_tx is missing');
  }
  return {
    registeredVk: hex(r.registered_vk, 'registered_vk'),
    proofVk: hex(r.proof_vk, 'proof_vk'),
    minimum: uint(r.minimum, 'minimum'),
    publicBalance: uint(r.public_balance, 'public_balance'),
    expiryBlock: uint(r.expiry_block, 'expiry_block'),
    currentBlock: uint(r.current_block, 'current_block'),
    recipient: hex(r.recipient, 'recipient'),
    conditionRecipient: hex(r.condition_recipient, 'condition_recipient'),
    amount: uint(r.amount, 'amount'),
    maxTransfer: uint(r.max_transfer, 'max_transfer'),
    proofTx: r.proof_tx,
  };
}

/** Seen-set key for a Proof reference: case and surrounding whitespace don't make a new reference. */
export function proofRefKey(proofTx: string): string {
  return proofTx.trim().toLowerCase();
}

export function parseMode(value: unknown): Mode {
  return value === 'competition' ? 'competition' : 'practice';
}
