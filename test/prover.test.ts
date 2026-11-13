import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error untyped module
import * as snarkjs from 'snarkjs';
import { decide } from '../src/checks.js';
import { toCircuitInputs } from '../src/encoding.js';
import { parseTaskInput } from '../src/parse.js';
import { Prover, shutdownProver } from '../src/prover.js';
import { rawInput } from './fixtures.js';

const prover = new Prover('circuits');
const vk = JSON.parse(readFileSync('circuits/gatekeeper_vk.json', 'utf8'));

afterAll(shutdownProver);

async function proveFor(over: Parameters<typeof rawInput>[0]) {
  const input = parseTaskInput(rawInput(over));
  const { decision } = decide(input, false);
  return { decision, outcome: await prover.prove(toCircuitInputs(input, 'gk_24_9d1', decision, 7n, 'keccak'), 30_000) };
}

describe('Prover', () => {
  it('proves an APPROVE that verifies against the published VK', async () => {
    const { decision, outcome } = await proveFor({});
    expect(decision).toBe('APPROVE');
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.result.locallyVerified).toBe(true);
    expect(await snarkjs.groth16.verify(vk, outcome.result.publicSignals, outcome.result.proof)).toBe(true);
    expect(outcome.result.publicSignals).toHaveLength(13);
    expect(outcome.result.publicSignals[11]).toBe('1'); // decision
  });

  it.each([
    ['VK substitution', { proof_vk: '0x13aa' }],
    ['threshold', { public_balance: '999' }],
    ['expiry', { current_block: 19842201 }],
    ['recipient', { recipient: '0x01' }],
    ['amount', { amount: '1001' }],
  ])('proves a REJECT for %s', async (_name, over) => {
    const { decision, outcome } = await proveFor(over);
    expect(decision).toBe('REJECT');
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.result.locallyVerified).toBe(true);
    expect(outcome.result.publicSignals[11]).toBe('0');
  });

  it('fails without throwing when asked to prove the wrong decision', async () => {
    const input = parseTaskInput(rawInput({ amount: '1001' }));
    const outcome = await prover.prove(toCircuitInputs(input, 'gk_1', 'APPROVE', 7n, 'keccak'), 30_000);
    expect(outcome.ok).toBe(false);
  });

  it('gives up when the budget is spent', async () => {
    const input = parseTaskInput(rawInput());
    const outcome = await prover.prove(toCircuitInputs(input, 'gk_1', 'APPROVE', 7n, 'keccak'), 0);
    expect(outcome.ok).toBe(false);
  });
});
