import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sign } from '../src/hmac.js';
import { shutdownProver } from '../src/prover.js';
import { envelope, rawInput } from './fixtures.js';

const SECRET = 'a'.repeat(64); // hex-looking, like a real rotated secret
const KEY = Buffer.from(SECRET, 'utf8');
let app: App;
let url: string;
let dataDir: string;

beforeAll(async () => {
  process.env.LOG_SILENT = '1';
  dataDir = mkdtempSync(join(tmpdir(), 'gk-test-'));
  app = createApp(loadConfig({ AGENT_GAMES_HMAC_SECRET: SECRET, DATA_DIR: dataDir, CIRCUITS_DIR: 'circuits' }));
  await new Promise<void>((r) => app.server.listen(0, r));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/agent`;
});

afterAll(async () => {
  await new Promise((r) => app.server.close(r));
  app.store.close();
  await shutdownProver();
  rmSync(dataDir, { recursive: true, force: true });
});

async function post(body: unknown, opts: { key?: Buffer; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-games-signature': opts.signature ?? sign(opts.key ?? KEY, raw),
    },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null, sig: res.headers.get('x-agent-games-signature') };
}

describe('transport', () => {
  it('answers GET as a health check', async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers a signed preflight, signing the response', async () => {
    const res = await post({ type: 'agent-games.preflight.v1', agent_id: 'agt_x', issued_at: 'now', nonce: 'n1' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, protocolVersion: 'v1' });
    expect(res.sig).toBe(sign(KEY, res.text));
  });

  it('also accepts a signature made with the hex-decoded secret, and signs back with it', async () => {
    const hexKey = Buffer.from(SECRET, 'hex');
    const res = await post({ type: 'agent-games.preflight.v1', nonce: 'n2' }, { key: hexKey });
    expect(res.status).toBe(200);
    expect(res.sig).toBe(sign(hexKey, res.text));
  });

  it('accepts a sha256= prefixed signature', async () => {
    const body = { type: 'agent-games.preflight.v1', nonce: 'n3' };
    const res = await post(body, { signature: `sha256=${sign(KEY, JSON.stringify(body))}` });
    expect(res.status).toBe(200);
  });

  it('rejects a bad signature with 401', async () => {
    const res = await post({ type: 'agent-games.preflight.v1' }, { signature: '00'.repeat(32) });
    expect(res.status).toBe(401);
  });
});

describe('gatekeeper end to end', () => {
  it('approves a valid Task with a proof and echoes proof_tx', async () => {
    const input = rawInput({ proof_tx: '0xvalid1' });
    const res = await post(envelope('gk_e2e_1', input));
    expect(res.status).toBe(200);
    expect(res.json.decision).toBe('APPROVE');
    expect(res.json.reason_code).toBe('VALID_CONDITION');
    expect(res.json.proof).toBeDefined();
    expect(res.json.public_signals).toHaveLength(13);
    expect(res.json.proof_tx).toBe('0xvalid1');
    expect(res.sig).toBe(sign(KEY, res.text));
  });

  it('answers a Retry with the identical body, not as a reuse', async () => {
    const env = envelope('gk_e2e_1', rawInput({ proof_tx: '0xvalid1' }));
    const res = await post(env);
    expect(res.json.decision).toBe('APPROVE');
    const again = await post(env);
    expect(again.text).toBe(res.text);
  });

  it('rejects a second Task carrying an approved Proof reference, without a proof', async () => {
    const res = await post(envelope('gk_e2e_2', rawInput({ proof_tx: '0xVALID1' })));
    expect(res.json).toEqual({ decision: 'REJECT', reason_code: 'PROOF_REUSED', proof_tx: '0xVALID1' });
  });

  it('does not count a rejected Task\'s Proof reference as seen', async () => {
    const first = await post(envelope('gk_e2e_3', rawInput({ proof_tx: '0xrej', amount: '5000' })));
    expect(first.json.reason_code).toBe('AMOUNT_OVERFLOW');
    expect(first.json.proof).toBeDefined();
    const second = await post(envelope('gk_e2e_4', rawInput({ proof_tx: '0xrej' })));
    expect(second.json.decision).toBe('APPROVE');
  });

  it('keeps practice and competition Seen-sets apart', async () => {
    const res = await post(envelope('gk_e2e_5', rawInput({ proof_tx: '0xvalid1' }), { mode: 'practice' }));
    expect(res.json.decision).toBe('APPROVE');
  });

  it('gives concurrent Retries one answer', async () => {
    const env = envelope('gk_e2e_6', rawInput({ proof_tx: '0xconcurrent' }));
    const [a, b] = await Promise.all([post(env), post(env)]);
    expect(a.text).toBe(b.text);
    expect(a.json.decision).toBe('APPROVE');
  });

  it('rejects malformed input as PUBLIC_INPUT_MISMATCH', async () => {
    const res = await post(envelope('gk_e2e_7', rawInput({ amount: 'lots' })));
    expect(res.json).toMatchObject({ decision: 'REJECT', reason_code: 'PUBLIC_INPUT_MISMATCH' });
    expect(res.json.proof).toBeUndefined();
  });

  it('still answers, without a proof, when the deadline has passed', async () => {
    const env = envelope('gk_e2e_8', rawInput({ proof_tx: '0xlate' }), {
      deadline_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await post(env);
    expect(res.json.decision).toBe('APPROVE');
    expect(res.json.proof).toBeUndefined();
  });
});
