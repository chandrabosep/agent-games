import type { TaskInput, Verdict } from './types.js';

/**
 * The Checks. Pure: same input, same Verdict. Runs in a fixed order and the
 * first failing Check names the Trap (GLOSSARY: Check, Trap).
 *
 * @param alreadySeen whether this Task's Proof reference is in the Seen-set for its Mode.
 */
export function decide(input: TaskInput, alreadySeen: boolean): Verdict {
  if (alreadySeen) return reject('PROOF_REUSED');
  if (input.proofVk !== input.registeredVk) return reject('VK_SUBSTITUTION');
  if (input.publicBalance < input.minimum) return reject('THRESHOLD_MISMATCH');
  if (input.currentBlock >= input.expiryBlock) return reject('EXPIRED_CONDITION');
  if (input.recipient !== input.conditionRecipient) return reject('RECIPIENT_MISMATCH');
  if (input.amount > input.maxTransfer) return reject('AMOUNT_OVERFLOW');
  return { decision: 'APPROVE', trap: null };
}

function reject(trap: NonNullable<Verdict['trap']>): Verdict {
  return { decision: 'REJECT', trap };
}
