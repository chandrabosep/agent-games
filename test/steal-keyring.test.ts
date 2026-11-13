import { describe, expect, it } from 'vitest';
// @ts-expect-error untyped module
import * as snarkjs from 'snarkjs';
import { loadKeyring } from '../src/steal/keyring.js';

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n; // BN254 scalar field order

const env = (over: Record<string, string | undefined> = {}) => ({
  STRATEGY_PARAMS: '4,30,120,0',
  STRATEGY_SALT: '1122334455667788',
  ...over,
});

describe('loadKeyring', () => {
  it('derives the Strategy commitment the circuit itself accepts', async () => {
    const keyring = loadKeyring(env());
    const entry = keyring.current!;
    // Independent check: the circuit asserts Poseidon(params, salt) == commitment.
    await snarkjs.wtns.calculate(
      {
        commitment: entry.commitment.toString(),
        matchId: '1',
        turnNumber: 1,
        selfBalance: 100,
        opponentBalance: 100,
        action: 0,
        amount: 0,
        circuitVersion: 1,
        strategyParams: ['4', '30', '120', '0', '0', '0', '0', '0'],
        salt: '1122334455667788',
      },
      'circuits/vfy-policy.wasm',
      { type: 'mem' },
    );
    expect(entry.params).toEqual([4, 30, 120, 0]);
  });

  it('finds an entry by the hash as the envelope writes it', () => {
    const keyring = loadKeyring(env());
    const hex = `0x${keyring.current!.commitment.toString(16).padStart(64, '0')}`;
    expect(keyring.find(hex)).toBe(keyring.current);
    expect(keyring.find(hex.toUpperCase().replace('0X', '0x'))).toBe(keyring.current);
    expect(keyring.find('0x1234')).toBeUndefined();
    expect(keyring.find(null)).toBeUndefined();
  });

  it('accepts all eight circuit params when the reserved four are zero', () => {
    expect(loadKeyring(env({ STRATEGY_PARAMS: '4,30,120,0,0,0,0,0' })).current!.params).toEqual([4, 30, 120, 0]);
  });

  it('keeps the previous commitment so a Match paired under it can finish', () => {
    const keyring = loadKeyring(env({ STRATEGY_PARAMS_PREVIOUS: '10,0,99,0', STRATEGY_SALT_PREVIOUS: '42' }));
    const prev = keyring.previous!;
    expect(prev.params).toEqual([10, 0, 99, 0]);
    expect(keyring.find(`0x${prev.commitment.toString(16)}`)).toBe(prev);
    expect(prev.commitment).not.toBe(keyring.current!.commitment);
  });

  it('is empty when no Strategy params are set', () => {
    const keyring = loadKeyring({});
    expect(keyring.current).toBeUndefined();
    expect(keyring.find('0x01')).toBeUndefined();
  });

  it.each([
    ['extract amount 0', { STRATEGY_PARAMS: '0,30,120,0' }],
    ['extract amount 11', { STRATEGY_PARAMS: '11,30,120,0' }],
    ['switch 2', { STRATEGY_PARAMS: '4,30,120,2' }],
    ['threshold above 16 bits', { STRATEGY_PARAMS: '4,65536,120,0' }],
    ['negative', { STRATEGY_PARAMS: '4,-1,120,0' }],
    ['not an integer', { STRATEGY_PARAMS: '4,3.5,120,0' }],
    ['three values', { STRATEGY_PARAMS: '4,30,120' }],
    ['reserved param set', { STRATEGY_PARAMS: '4,30,120,0,0,1,0,0' }],
    ['missing salt', { STRATEGY_SALT: undefined }],
    ['salt not a number', { STRATEGY_SALT: 'abc' }],
    ['salt at the field size', { STRATEGY_SALT: FIELD.toString() }],
    ['previous params without salt', { STRATEGY_PARAMS_PREVIOUS: '4,30,120,0' }],
  ])('refuses %s, without echoing the values', (_name, over) => {
    let message = '';
    try {
      loadKeyring(env(over));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/STRATEGY_/);
    expect(message).not.toContain('1122334455667788');
    expect(message).not.toContain('120');
  });
});
