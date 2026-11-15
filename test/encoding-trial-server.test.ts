import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { taskIdToField } from '../src/encoding.js';
import type { Standing } from '../src/encodingTrial.js';
import { sign } from '../src/hmac.js';
import { shutdownProver } from '../src/prover.js';
import { envelope, rawInput } from './fixtures.js';

const SECRET = 'b'.repeat(64);
let app: App;
let url: string;
let dataDir: string;
let standing: Standing = { score: 150, correct: 15, timeouts: 0 };

beforeAll(async () => {
  process.env.LOG_SILENT = '1';
  dataDir = mkdtempSync(join(tmpdir(), 'gk-trial-e2e-'));
  app = createApp(
    loadConfig({
      AGENT_GAMES_HMAC_SECRET: SECRET,
      DATA_DIR: dataDir,
      CIRCUITS_DIR: 'circuits',
      TASK_ID_ENCODING: 'uuid-tail,keccak-shr8,keccak',
    }),
    { fetchStanding: async () => standing },
  );
  await new Promise<void>((r) => app.server.listen(0, r));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/agent`;
});

afterAll(async () => {
  await app.stop();
  await shutdownProver();
  rmSync(dataDir, { recursive: true, force: true });
});

async function answer(taskId: string, mode: 'competition' | 'practice' = 'competition') {
  const raw = JSON.stringify(envelope(taskId, rawInput({ proof_tx: `0x${taskId}` }), { mode }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-agent-games-signature': sign(Buffer.from(SECRET, 'utf8'), raw) },
    body: raw,
  });
  return (await res.json()) as { decision: string; public_signals: string[] };
}

describe('Encoding trial end to end', () => {
  const first = 'task_R04_16e835e2-9c68-4307-30da-4b8a25ebd319';
  const second = 'task_R04_5c5312a5-5af4-bb62-1769-8b8add22c01e';

  it('does not let a practice Task move the trial', async () => {
    await app.encodingTrial.refreshBaseline();
    await new Promise((r) => setTimeout(r, 5));
    await answer('practice_151e206a-22d5-a939-2578-a12dc56fd6ab', 'practice');
    standing = { score: 160, correct: 16, timeouts: 0 };
    await app.encodingTrial.check(true);
    expect(app.encodingTrial.current()).toBe('uuid-tail');
    standing = { score: 150, correct: 15, timeouts: 0 };
  });

  it('proves with the first candidate, and with the next once the platform gave no Proof credit', async () => {
    await app.encodingTrial.refreshBaseline();
    await new Promise((r) => setTimeout(r, 5)); // the Task must arrive after the baseline
    const a = await answer(first);
    expect(a.decision).toBe('APPROVE');
    expect(a.public_signals[12]).toBe(taskIdToField(first, 'uuid-tail').toString());

    standing = { score: 160, correct: 16, timeouts: 0 };
    await app.encodingTrial.check(true);
    expect(app.encodingTrial.current()).toBe('keccak-shr8');

    const b = await answer(second);
    expect(b.decision).toBe('APPROVE');
    expect(b.public_signals[12]).toBe(taskIdToField(second, 'keccak-shr8').toString());
  });
});
