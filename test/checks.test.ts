import { describe, expect, it } from 'vitest';
import { decide } from '../src/checks.js';
import { MalformedInput, parseTaskInput } from '../src/parse.js';
import { reasonCodeFor } from '../src/reasonCodes.js';
import { rawInput } from './fixtures.js';

const verdict = (over: Parameters<typeof rawInput>[0] = {}, seen = false) => {
  const v = decide(parseTaskInput(rawInput(over)), seen);
  return { decision: v.decision, reason: reasonCodeFor(v) };
};

describe('Checks: one Trap each', () => {
  it('approves a Task that passes every Check', () => {
    expect(verdict()).toEqual({ decision: 'APPROVE', reason: 'VALID_CONDITION' });
  });
  it('rejects a reused Proof reference', () => {
    expect(verdict({}, true)).toEqual({ decision: 'REJECT', reason: 'PROOF_REUSED' });
  });
  it('rejects VK substitution', () => {
    expect(verdict({ proof_vk: '0x13aa' })).toEqual({ decision: 'REJECT', reason: 'VK_SUBSTITUTION' });
  });
  it('rejects a balance below the minimum', () => {
    expect(verdict({ public_balance: '999' })).toEqual({ decision: 'REJECT', reason: 'THRESHOLD_MISMATCH' });
  });
  it('rejects an expired condition', () => {
    expect(verdict({ current_block: 19842202 })).toEqual({ decision: 'REJECT', reason: 'EXPIRED_CONDITION' });
  });
  it('rejects a recipient mismatch', () => {
    expect(verdict({ recipient: '0xde42a1b2c3d4e5f60718293a4b5c6d7e8f909f02' })).toEqual({
      decision: 'REJECT',
      reason: 'RECIPIENT_MISMATCH',
    });
  });
  it('rejects an amount over max_transfer', () => {
    expect(verdict({ amount: '1001' })).toEqual({ decision: 'REJECT', reason: 'AMOUNT_OVERFLOW' });
  });
});

describe('Checks: boundaries', () => {
  it('balance equal to minimum passes', () => {
    expect(verdict({ public_balance: '1000' }).decision).toBe('APPROVE');
  });
  it('amount equal to max_transfer passes', () => {
    expect(verdict({ amount: '1000' }).decision).toBe('APPROVE');
  });
  it('current_block equal to expiry_block is expired', () => {
    expect(verdict({ current_block: 19842201 }).reason).toBe('EXPIRED_CONDITION');
  });
  it('compares hex without regard to case or 0x prefix', () => {
    expect(
      verdict({ proof_vk: '6B79C6012A6D8651F3E13BC4D2A20370280AB49700C90C5316D4168BFBAD77B0' }).decision,
    ).toBe('APPROVE');
  });
  it('compares amounts beyond float precision exactly', () => {
    expect(
      verdict({ amount: '9007199254740993', max_transfer: '9007199254740992', public_balance: '1460' }).reason,
    ).toBe('AMOUNT_OVERFLOW');
  });
  it('accepts block numbers given as strings', () => {
    expect(verdict({ current_block: '19832000', expiry_block: '19842201' }).decision).toBe('APPROVE');
  });
});

describe('Checks: order when a Task has several Traps', () => {
  it('reuse beats every other Trap', () => {
    expect(verdict({ proof_vk: '0x01', amount: '5000' }, true).reason).toBe('PROOF_REUSED');
  });
  it('VK substitution beats expiry', () => {
    expect(verdict({ proof_vk: '0x01', current_block: 99999999 }).reason).toBe('VK_SUBSTITUTION');
  });
  it('threshold beats recipient and amount', () => {
    expect(verdict({ public_balance: '1', recipient: '0x01', amount: '5000' }).reason).toBe('THRESHOLD_MISMATCH');
  });
  it('expiry beats recipient', () => {
    expect(verdict({ current_block: 99999999, recipient: '0x01' }).reason).toBe('EXPIRED_CONDITION');
  });
  it('recipient beats amount', () => {
    expect(verdict({ recipient: '0x01', amount: '5000' }).reason).toBe('RECIPIENT_MISMATCH');
  });
});

describe('parse: malformed input', () => {
  it.each([
    ['missing field', { minimum: undefined }],
    ['negative amount', { amount: '-1' }],
    ['fractional amount', { amount: '1.5' }],
    ['non-hex vk', { proof_vk: '0xzz' }],
    ['empty proof_tx', { proof_tx: '' }],
  ])('rejects %s', (_name, over) => {
    expect(() => parseTaskInput(rawInput(over))).toThrow(MalformedInput);
  });
});
