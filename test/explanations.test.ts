import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Explainer } from '../src/explainer.js';
import { sign } from '../src/hmac.js';
import { shutdownProver } from '../src/prover.js';
import { envelope, rawInput } from './fixtures.js';

const SECRET = 'explain-test-secret';
const KEY = Buffer.from(SECRET, 'utf8');
let app: App | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  if (app) {
    await app.stop();
    app = undefined;
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  await shutdownProver();
});

async function start(explainer: Explainer): Promise<string> {
  process.env.LOG_SILENT = '1';
  dataDir = mkdtempSync(join(tmpdir(), 'gk-explain-'));
  app = createApp(loadConfig({ AGENT_GAMES_HMAC_SECRET: SECRET, DATA_DIR: dataDir, CIRCUITS_DIR: 'circuits' }), {
    explainer,
  });
  await new Promise<void>((r) => app!.server.listen(0, r));
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

async function postTask(base: string, body: unknown) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-games-signature': sign(KEY, raw) },
    body: raw,
  });
  return res.json();
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('explanations', () => {
  it('publishes an explanation for an answered Task', async () => {
    const base = await start(async (f) => `Explained ${f.decision} because ${f.reasonCode}.`);
    await postTask(base, envelope('gk_x_1', rawInput({ amount: '5000' })));

    const entry = await waitFor(async () => {
      const list = (await (await fetch(`${base}/explanations.json`)).json()) as { taskId: string; explanation: string | null }[];
      return list.find((e) => e.taskId === 'gk_x_1' && e.explanation !== null);
    });
    expect(entry).toMatchObject({
      taskId: 'gk_x_1',
      decision: 'REJECT',
      reasonCode: 'AMOUNT_OVERFLOW',
      explanation: 'Explained REJECT because AMOUNT_OVERFLOW.',
    });
  });

  it('answers a Task on time while the explainer hangs', async () => {
    let release!: () => void;
    const gate = new Promise<null>((r) => (release = () => r(null)));
    const base = await start(() => gate);

    const started = Date.now();
    const res = await postTask(base, envelope('gk_x_2', rawInput({ proof_tx: '0xhang' })));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res).toMatchObject({ decision: 'APPROVE', reason_code: 'VALID_CONDITION', proof_tx: '0xhang' });
    expect(res.proof).toBeDefined();
    release();
  });

  it('answers normally when the explainer throws', async () => {
    const base = await start(async () => {
      throw new Error('boom');
    });
    const res = await postTask(base, envelope('gk_x_3', rawInput({ public_balance: '1' })));
    expect(res).toMatchObject({ decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
    expect(res.proof).toBeDefined();
  });

  it('escapes platform-supplied text on the public page', async () => {
    const base = await start(async () => 'Rejected <b>loudly</b>.');
    await postTask(base, envelope('gk_<script>x</script>', rawInput({ amount: '5000' })));
    const html = await waitFor(async () => {
      const page = await (await fetch(`${base}/explanations`)).text();
      return page.includes('loudly') ? page : undefined;
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('gk_&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('Rejected &lt;b&gt;loudly&lt;/b&gt;.');
  });
});
