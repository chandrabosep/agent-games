import type { Verdict } from './types.js';

/**
 * The one place reason-code strings live. The site publishes two conflicting
 * sets; this is the event-page set. If practice mode rejects it, change here only.
 */
export const REASON_CODES = {
  VALID: 'VALID_CONDITION',
  PROOF_REUSED: 'PROOF_REUSED',
  VK_SUBSTITUTION: 'VK_SUBSTITUTION',
  THRESHOLD_MISMATCH: 'THRESHOLD_MISMATCH',
  EXPIRED_CONDITION: 'EXPIRED_CONDITION',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  AMOUNT_OVERFLOW: 'AMOUNT_OVERFLOW',
  /** Signed request whose input could not be parsed. No event-page code fits. */
  MALFORMED: 'PUBLIC_INPUT_MISMATCH',
} as const;

export function reasonCodeFor(verdict: Verdict): string {
  return verdict.trap === null ? REASON_CODES.VALID : REASON_CODES[verdict.trap];
}
