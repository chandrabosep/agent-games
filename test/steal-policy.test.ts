import { describe, expect, it } from 'vitest';
import { poseidon9 } from 'poseidon-lite';
// @ts-expect-error untyped module
import * as snarkjs from 'snarkjs';
import { policy, type StrategyParams } from '../src/steal/policy.js';
import type { ActionCode } from '../src/steal/policy.js';

const WASM = 'circuits/vfy-policy.wasm';
const SALT = 987654321n;

/**
 * Source of truth: the organizers' circuit. A (action, amount) is what the policy
 * outputs exactly when the circuit's witness can be computed for it.
 */
async function circuitAccepts(params: StrategyParams, self: number, opp: number, action: ActionCode, amount: number) {
  const strategyParams = [...params, 0, 0, 0, 0].map(BigInt);
  const input = {
    commitment: poseidon9([...strategyParams, SALT]).toString(),
    matchId: '1234',
    turnNumber: 7,
    selfBalance: self,
    opponentBalance: opp,
    action,
    amount,
    circuitVersion: 1,
    strategyParams: strategyParams.map(String),
    salt: SALT.toString(),
  };
  try {
    await snarkjs.wtns.calculate(input, WASM, { type: 'mem' });
    return true;
  } catch {
    return false;
  }
}

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

describe('policy agrees with the vfy-policy circuit', () => {
  it('on every threshold boundary and on random states', async () => {
    const r = rng(42);
    const cases: Array<[StrategyParams, number, number]> = [
      // Boundaries: self = P1 - 1 / P1, opp = P2 / P2 + 1, switch on and off.
      [[10, 50, 100, 0], 49, 101],
      [[10, 50, 100, 0], 50, 101],
      [[10, 50, 100, 0], 50, 100],
      [[3, 50, 100, 1], 50, 101],
      [[1, 0, 0, 0], 0, 1],
      [[7, 0, 0, 0], 0, 0],
    ];
    for (let i = 0; i < 60; i++) {
      cases.push([[1 + r(10), r(160), r(160), r(2) as 0 | 1], r(220), r(220)]);
    }
    for (const [params, self, opp] of cases) {
      const { action, amount } = policy(params, { selfBalance: self, opponentBalance: opp });
      expect(await circuitAccepts(params, self, opp, action, amount), `${params} ${self}/${opp}`).toBe(true);
      // And no other action is accepted (the circuit admits exactly one).
      const other: ActionCode = ((action + 1) % 3) as ActionCode;
      expect(await circuitAccepts(params, self, opp, other, other === 2 ? params[0] : 0)).toBe(false);
    }
  }, 120_000);
});
