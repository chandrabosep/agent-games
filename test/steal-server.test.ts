import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error untyped module
import * as snarkjs from 'snarkjs';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sign } from '../src/hmac.js';
import { shutdownProver } from '../src/prover.js';
import { commitmentHex, loadKeyring } from '../src/steal/keyring.js';

const SECRET = 'b'.repeat(64);
const KEY = Buffer.from(SECRET, 'utf8');
// The Steal entry may be a second agent with its own secret on the same endpoint.
const STEAL_SECRET = 'c'.repeat(64);
const STEAL_KEY = Buffer.from(STEAL_SECRET, 'utf8');
// Test-only strategy: extract 7 when opp > 100, fortify when self < 90.
const STRATEGY = { STRATEGY_PARAMS: '7,90,100,0', STRATEGY_SALT: '5550001' };
const PREVIOUS = { STRATEGY_PARAMS_PREVIOUS: '3,0,0,0', STRATEGY_SALT_PREVIOUS: '777' };
const keyring = loadKeyring({ ...STRATEGY, ...PREVIOUS });
const CURRENT = commitmentHex(keyring.current!);
const OLD = commitmentHex(keyring.previous!);
const vk = JSON.parse(readFileSync('circuits/vfy-policy_vk.json', 'utf8'));

let app: App;
let url: string;
let dataDir: string;

beforeAll(async () => {
  process.env.LOG_SILENT = '1';
  dataDir = mkdtempSync(join(tmpdir(), 'steal-test-'));
  app = createApp(
    loadConfig({
      AGENT_GAMES_HMAC_SECRET: SECRET,
      AGENT_GAMES_HMAC_SECRET_STEAL: STEAL_SECRET,
      DATA_DIR: dataDir,
      CIRCUITS_DIR: 'circuits',
      ...STRATEGY,
      ...PREVIOUS,
    }),
  );
  await new Promise<void>((r) => app.server.listen(0, r));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/agent`;
});

afterAll(async () => {
  await app.stop();
  await shutdownProver();
  rmSync(dataDir, { recursive: true, force: true });
});

function turnEnvelope(over: { matchId?: string; turn?: number; self?: string; opp?: string; hash?: string | null; mode?: string } = {}) {
  return {
    protocolVersion: 'v1',
    eventId: 'steal-the-vfy',
    mode: over.mode ?? 'competition',
    matchId: over.matchId ?? '9f4e1b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
    turn: over.turn ?? 3,
    issuedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    state: { selfBalance: over.self ?? '95', opponentBalance: over.opp ?? '105', selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    strategyCommitment: { hash: over.hash === undefined ? CURRENT : over.hash },
    resolverVersion: 'v1',
    nonce: `n-${Math.random()}`,
  };
}

async function post(body: unknown, to = url, key = KEY) {
  const raw = JSON.stringify(body);
  const res = await fetch(to, { method: 'POST', headers: { 'x-agent-games-signature': sign(key, raw) }, body: raw });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text), sig: res.headers.get('x-agent-games-signature') };
}

/** The /build formula, restated: keccak256 over eight 32-byte big-endian words. */
function buildPublicInputsHash(commitment: string, matchId: string, turn: number, self: number, opp: number, action: number, amount: number) {
  const words = [BigInt(commitment), BigInt(`0x${matchId.replace(/-/g, '')}`), turn, self, opp, action, amount, 1].map((v) =>
    BigInt(v).toString(16).padStart(64, '0'),
  );
  return `0x${Buffer.from(keccak_256(Buffer.from(words.join(''), 'hex'))).toString('hex')}`;
}

describe('Steal the VFY turns over /agent', () => {
  it('plays the committed Action with a Policy proof that verifies', async () => {
    const env = turnEnvelope({ turn: 3, self: '95', opp: '105' });
    const res = await post(env);
    expect(res.status).toBe(200);
    expect(res.sig).toBe(sign(KEY, res.text));
    expect(res.json.matchId).toBe(env.matchId);
    expect(res.json.turn).toBe(3);
    expect(res.json.action).toEqual({ type: 'EXTRACT', amount: 7 });
    expect(res.json.policyProof.circuitVersion).toBe('v1');
    expect(res.json.policyProof.publicInputsHash).toBe(buildPublicInputsHash(CURRENT, env.matchId, 3, 95, 105, 2, 7));
    expect(await snarkjs.groth16.verify(vk, res.json.public_signals, res.json.proof)).toBe(true);
    expect(res.json.public_signals).toHaveLength(9);
    expect(res.json.public_signals).toContain(BigInt(CURRENT).toString());
    // The platform's schema rejects UUID-shaped strings without a valid version and variant.
    expect(res.json.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(typeof res.json.agentTimestamp).toBe('string');
  });

  it('omits amount for FORTIFY and HOLD', async () => {
    const fortify = await post(turnEnvelope({ turn: 4, self: '80', opp: '120' }));
    expect(fortify.json.action).toEqual({ type: 'FORTIFY' });
    expect(fortify.json.proof).toBeDefined();
    const hold = await post(turnEnvelope({ turn: 5, self: '100', opp: '100' }));
    expect(hold.json.action).toEqual({ type: 'HOLD' });
    expect(hold.json.proof).toBeDefined();
    expect(hold.json.idempotencyKey).not.toBe(fortify.json.idempotencyKey);
  });

  it('accepts a Turn signed with the second agent\'s secret and signs back with it', async () => {
    const res = await post(turnEnvelope({ matchId: '66666666-2222-4333-8444-555555555555' }), url, STEAL_KEY);
    expect(res.status).toBe(200);
    expect(res.sig).toBe(sign(STEAL_KEY, res.text));
    expect(res.json.action).toEqual({ type: 'EXTRACT', amount: 7 });
    const preflight = await post({ type: 'agent-games.preflight.v1', nonce: 's' }, url, STEAL_KEY);
    expect(preflight.status).toBe(200);
  });

  it('answers a Retry with the identical body', async () => {
    const env = turnEnvelope({ turn: 6 });
    const first = await post(env);
    const again = await post({ ...env, nonce: 'other' });
    expect(again.text).toBe(first.text);
  });

  it('plays a Match paired under the previous commitment with that commitment', async () => {
    const res = await post(turnEnvelope({ matchId: '11111111-2222-4333-8444-555555555555', turn: 1, self: '100', opp: '100', hash: OLD }));
    expect(res.json.action).toEqual({ type: 'EXTRACT', amount: 3 });
    expect(res.json.public_signals).toContain(BigInt(OLD).toString());
  });

  it('sends a Fallback HOLD without a proof for an unknown commitment', async () => {
    const matchId = '22222222-2222-4333-8444-555555555555';
    const res = await post(turnEnvelope({ matchId, turn: 9, hash: `0x${'ab'.repeat(32)}` }));
    expect(res.status).toBe(200);
    expect(res.json.action).toEqual({ type: 'HOLD' });
    expect(res.json.proof).toBeUndefined();
    expect(res.json.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('proves a practice turn with no commitment hash against the current commitment', async () => {
    const res = await post(turnEnvelope({ matchId: '33333333-2222-4333-8444-555555555555', mode: 'practice', hash: null }));
    expect(res.json.action).toEqual({ type: 'EXTRACT', amount: 7 });
    expect(res.json.public_signals).toContain(BigInt(CURRENT).toString());
  });
});

describe('Steal the VFY when it cannot prove', () => {
  const others: Array<{ app: App; dir: string }> = [];
  async function startApp(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'steal-test-'));
    const other = createApp(loadConfig({ AGENT_GAMES_HMAC_SECRET: SECRET, DATA_DIR: dir, CIRCUITS_DIR: 'circuits', ...env }));
    await new Promise<void>((r) => other.server.listen(0, r));
    others.push({ app: other, dir });
    return `http://127.0.0.1:${(other.server.address() as AddressInfo).port}/agent`;
  }
  afterAll(async () => {
    for (const o of others) {
      await o.app.stop();
      rmSync(o.dir, { recursive: true, force: true });
    }
  });

  it('sends a Fallback HOLD when the Policy proof misses its time budget, with the same idempotencyKey', async () => {
    const slow = await startApp({ ...STRATEGY, STEAL_PROOF_BUDGET_MS: '1' });
    const env = turnEnvelope({ matchId: '44444444-2222-4333-8444-555555555555', turn: 2 });
    const late = await post(env, slow);
    expect(late.json.action).toEqual({ type: 'HOLD' });
    expect(late.json.proof).toBeUndefined();
    const proven = await post(env);
    expect(proven.json.action).toEqual({ type: 'EXTRACT', amount: 7 });
    expect(proven.json.idempotencyKey).toBe(late.json.idempotencyKey);
  });

  it('keeps serving Gatekeeper and plays Fallback HOLDs when the Strategy params are illegal', async () => {
    const broken = await startApp({ STRATEGY_PARAMS: '0,90,100,0', STRATEGY_SALT: '5550001' });
    const preflight = await post({ type: 'agent-games.preflight.v1', nonce: 'p' }, broken);
    expect(preflight.json).toEqual({ ok: true, protocolVersion: 'v1' });
    const turn = await post(turnEnvelope({ matchId: '55555555-2222-4333-8444-555555555555' }), broken);
    expect(turn.json.action).toEqual({ type: 'HOLD' });
    expect(turn.json.proof).toBeUndefined();
  });
});
