/**
 * The vfy-policy circuit's rule, mirrored exactly (test/steal-policy.test.ts
 * checks it against the circuit). The values are the user's, never a model's.
 *
 * The four Strategy params that matter: [extract amount 1..10, fortify threshold,
 * extract threshold, extract disabled 0|1]; the circuit's other four are always 0.
 */
export type StrategyParams = readonly [number, number, number, 0 | 1];

/** Action codes as the circuit and publicInputsHash encode them. */
export const ACTION = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 } as const;
export type ActionName = keyof typeof ACTION;
export type ActionCode = (typeof ACTION)[ActionName];
export const ACTION_NAMES: Record<ActionCode, ActionName> = { 0: 'HOLD', 1: 'FORTIFY', 2: 'EXTRACT' };

/** The circuit compares balances and thresholds in 16 bits. */
export const UINT16_MAX = 65535;

export interface PublicState {
  selfBalance: number;
  opponentBalance: number;
}

/** An Action with its amount (0 unless EXTRACT). */
export interface Play {
  action: ActionCode;
  amount: number;
}

export function policy(
  [extractAmount, fortifyBelow, extractAbove, extractDisabled]: StrategyParams,
  { selfBalance, opponentBalance }: PublicState,
): Play {
  if (selfBalance < fortifyBelow) return { action: ACTION.FORTIFY, amount: 0 };
  if (opponentBalance > extractAbove && extractDisabled === 0) return { action: ACTION.EXTRACT, amount: extractAmount };
  return { action: ACTION.HOLD, amount: 0 };
}
