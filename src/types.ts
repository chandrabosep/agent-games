export type Decision = 'APPROVE' | 'REJECT';

export type Mode = 'practice' | 'competition';

/** The six Traps, in the order their Checks run. */
export const TRAPS = [
  'PROOF_REUSED',
  'VK_SUBSTITUTION',
  'THRESHOLD_MISMATCH',
  'EXPIRED_CONDITION',
  'RECIPIENT_MISMATCH',
  'AMOUNT_OVERFLOW',
] as const;
export type Trap = (typeof TRAPS)[number];

/** A Task's input after parsing: every number is an exact bigint, every hex value is its integer value. */
export interface TaskInput {
  registeredVk: bigint;
  proofVk: bigint;
  minimum: bigint;
  publicBalance: bigint;
  expiryBlock: bigint;
  currentBlock: bigint;
  recipient: bigint;
  conditionRecipient: bigint;
  amount: bigint;
  maxTransfer: bigint;
  /** Proof reference (`proof_tx`), exactly as received. */
  proofTx: string;
}

export interface Verdict {
  decision: Decision;
  /** The first failing Check's Trap; null on APPROVE. */
  trap: Trap | null;
}
