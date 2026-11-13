import { afterAll, describe, expect, it } from 'vitest';
import { Prover, shutdownProver } from '../src/prover.js';
import {
  circuitInput,
  policyCommitment,
  publicSignals,
  refusal,
  type Payment,
  type Policy,
} from '../src/wildcard/policy.js';

const prover = new Prover('wildcard/artifacts', 'policy_payment');
afterAll(shutdownProver);

const VENDOR_A = 0x1111111111111111111111111111111111111111n;
const VENDOR_B = 0x2222222222222222222222222222222222222222n;
const STRANGER = 0x3333333333333333333333333333333333333333n;

const policy: Policy = {
  maxPerTx: 500_000_000n, // 500 USDC (6 decimals)
  policyExpiry: 1_800_000_000n,
  allowlist: [VENDOR_A, VENDOR_B],
  salt: 123456789n,
};

const good: Payment = {
  recipient: VENDOR_B,
  amount: 120_000_000n,
  nonce: 1n,
  validUntil: 1_790_000_000n,
  vault: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn,
  chainId: 84532n,
};

/** Bypasses the mirror: asks the circuit directly, the way a misbehaving agent would. */
async function circuitAccepts(pol: Policy, p: Payment, allowlistOverride?: bigint[]): Promise<boolean> {
  const input = circuitInput({ ...pol, allowlist: allowlistOverride ?? pol.allowlist }, p);
  input.policyCommitment = policyCommitment(pol).toString(); // the committed policy, not the override
  const out = await prover.prove(input, 30_000);
  return out.ok && out.result.locallyVerified;
}

describe('Policy Vault circuit', () => {
  it('proves an allowed payment, with public signals in the documented order', async () => {
    expect(refusal(policy, good)).toBeNull();
    const out = await prover.prove(circuitInput(policy, good), 30_000);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.locallyVerified).toBe(true);
    expect(out.result.publicSignals).toEqual(publicSignals(policy, good).map(String));
  });

  it('accepts a payment of exactly maxPerTx and a deadline equal to policyExpiry', async () => {
    const edge = { ...good, amount: policy.maxPerTx, validUntil: policy.policyExpiry };
    expect(refusal(policy, edge)).toBeNull();
    expect(await circuitAccepts(policy, edge)).toBe(true);
  });

  it.each([
    ['OVER_LIMIT', { amount: policy.maxPerTx + 1n }],
    ['ZERO_AMOUNT', { amount: 0n }],
    ['AFTER_POLICY_EXPIRY', { validUntil: policy.policyExpiry + 1n }],
  ] as const)('refuses %s, and the circuit refuses it too', async (reason, change) => {
    const bad = { ...good, ...change };
    expect(refusal(policy, bad)).toBe(reason);
    expect(await circuitAccepts(policy, bad)).toBe(false);
  });

  it('refuses a recipient off the allowlist, even when the agent lies about the allowlist', async () => {
    const bad = { ...good, recipient: STRANGER };
    expect(refusal(policy, bad)).toBe('NOT_ALLOWLISTED');
    expect(() => circuitInput(policy, bad)).toThrow();
    // Prove against a forged allowlist that includes the stranger: the commitment no longer matches.
    expect(await circuitAccepts(policy, bad, [VENDOR_A, VENDOR_B, STRANGER])).toBe(false);
  });

  it('refuses a policy with a different limit or salt (commitment mismatch)', async () => {
    const looser = { ...policy, maxPerTx: policy.maxPerTx * 10n };
    const input = circuitInput(looser, { ...good, amount: policy.maxPerTx * 2n });
    input.policyCommitment = policyCommitment(policy).toString();
    const out = await prover.prove(input, 30_000);
    expect(out.ok).toBe(false);
  });

  it('commitment changes with every policy field', () => {
    const base = policyCommitment(policy);
    expect(policyCommitment({ ...policy, maxPerTx: policy.maxPerTx - 1n })).not.toBe(base);
    expect(policyCommitment({ ...policy, policyExpiry: policy.policyExpiry - 1n })).not.toBe(base);
    expect(policyCommitment({ ...policy, allowlist: [VENDOR_A] })).not.toBe(base);
    expect(policyCommitment({ ...policy, salt: policy.salt + 1n })).not.toBe(base);
  });
});

describe('zkVerify leaf (TypeScript)', () => {
  it('matches the leaf Kurier returned for a real proof (spike job a580d3ba, aggregation 64987)', async () => {
    const { groth16Leaf } = await import('../src/wildcard/zkverify.js');
    const signals = [
      '5159209261604496338057099923251677359437788295215516717881494780951457243165',
      '999', '999', '1000', '1460', '19842201', '19832000', '111', '111', '500', '1000', '1', '1794584016440',
    ];
    expect(groth16Leaf('0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0', signals)).toBe(
      '0x95b00e606273fac7d20936d073ed3a257d3c04b6ab4aa1433cbbd1d077387138',
    );
  });
});
