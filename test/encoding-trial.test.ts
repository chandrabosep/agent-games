import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BN254_P, parseTaskIdEncodings, taskIdToField, type TaskIdEncoding } from '../src/encoding.js';
import { EncodingTrial, type Standing } from '../src/encodingTrial.js';
import { Store } from '../src/store.js';

const TASK_ID = 'task_R03_16e835e2-9c68-4307-30da-4b8a25ebd319';

describe('task_id encodings', () => {
  it('uuid-tail reads the trailing UUID as an integer, whatever the prefix', () => {
    const expected = BigInt('0x16e835e29c68430730da4b8a25ebd319');
    expect(taskIdToField(TASK_ID, 'uuid-tail')).toBe(expected);
    expect(taskIdToField('practice_16e835e2-9c68-4307-30da-4b8a25ebd319', 'uuid-tail')).toBe(expected);
  });

  it('uuid-tail falls back to keccak when the id has no UUID', () => {
    expect(taskIdToField('gk_24_9d1', 'uuid-tail')).toBe(taskIdToField('gk_24_9d1', 'keccak'));
  });

  it('keccak-shr8 drops the hash’s last byte and stays below the field modulus', () => {
    // keccak256("task_R03_…") reduced mod p differs from its top 31 bytes.
    const shr8 = taskIdToField(TASK_ID, 'keccak-shr8');
    expect(shr8 < 1n << 248n).toBe(true);
    expect(shr8 < BN254_P).toBe(true);
    expect(shr8).not.toBe(taskIdToField(TASK_ID, 'keccak'));
  });

  it('parses a candidate list and refuses unknown or repeated names', () => {
    expect(parseTaskIdEncodings('uuid-tail, keccak')).toEqual(['uuid-tail', 'keccak']);
    expect(parseTaskIdEncodings('keccak')).toEqual(['keccak']);
    expect(() => parseTaskIdEncodings('uuid-tail,md5')).toThrow();
    expect(() => parseTaskIdEncodings('keccak,keccak')).toThrow();
    expect(() => parseTaskIdEncodings('')).toThrow();
  });
});

describe('Encoding trial', () => {
  const CANDIDATES: TaskIdEncoding[] = ['uuid-tail', 'keccak-shr8', 'keccak'];
  let dir: string;
  let store: Store;
  let standing: Standing | null;
  let clock: number;

  beforeEach(() => {
    process.env.LOG_SILENT = '1';
    dir = mkdtempSync(join(tmpdir(), 'gk-trial-'));
    store = new Store(dir);
    standing = { score: 150, correct: 15, timeouts: 0 };
    clock = 1_000;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // No timers: the tests drive refreshBaseline() and check() themselves.
  const trial = (candidates = CANDIDATES) =>
    new EncodingTrial({ store, candidates, fetchStanding: async () => standing, pollDelaysMs: [], now: () => clock });

  /** Takes a baseline, then answers one Task with the current candidate. */
  async function answerTask(t: EncodingTrial, taskId = 't1') {
    await t.refreshBaseline();
    clock += 1_000;
    t.observe({ taskId, encoding: t.current(), receivedAt: clock });
  }

  it('starts on the first candidate', () => {
    expect(trial().current()).toBe('uuid-tail');
    expect(trial().status()).toBe('open');
  });

  it('confirms a candidate as soon as its Task scores 12, and keeps it after a restart', async () => {
    const t = trial();
    await answerTask(t);
    standing = { score: 162, correct: 16, timeouts: 0 };
    await t.check(false);
    expect(t.status()).toBe('confirmed');
    expect(t.current()).toBe('uuid-tail');
    expect(trial().status()).toBe('confirmed');
    expect(trial().current()).toBe('uuid-tail');
  });

  it('moves to the next candidate only when the last reading still shows 10', async () => {
    const t = trial();
    await answerTask(t);
    standing = { score: 160, correct: 16, timeouts: 0 };
    await t.check(false);
    expect(t.current()).toBe('uuid-tail'); // the Proof credit may still arrive
    await t.check(true);
    expect(t.current()).toBe('keccak-shr8');
    expect(t.status()).toBe('open');
    expect(trial().current()).toBe('keccak-shr8'); // survives a restart
  });

  it('confirms when the Proof credit arrives after the Decision was scored', async () => {
    const t = trial();
    await answerTask(t);
    standing = { score: 160, correct: 16, timeouts: 0 };
    await t.check(false);
    standing = { score: 162, correct: 16, timeouts: 0 };
    await t.check(true);
    expect(t.status()).toBe('confirmed');
    expect(t.current()).toBe('uuid-tail');
  });

  it('accepts the leaderboard’s one-decimal rounding', async () => {
    const t = trial();
    standing = { score: 171.9, correct: 15, timeouts: 0 };
    await answerTask(t);
    standing = { score: 183.9, correct: 16, timeouts: 0 };
    await t.check(false);
    expect(t.status()).toBe('confirmed');
  });

  it('changes nothing when the Task is not scored, the score moves oddly, or the Standing is unreadable', async () => {
    for (const after of [
      { score: 150, correct: 15, timeouts: 0 }, // not scored
      { score: 144, correct: 15, timeouts: 0 }, // Decision judged wrong
      { score: 165.6, correct: 16, timeouts: 0 }, // round bonus landed with it
      { score: 172, correct: 17, timeouts: 0 }, // two Tasks scored
      { score: 158, correct: 16, timeouts: 1 }, // a timeout in between
      null,
    ]) {
      const t = trial();
      standing = { score: 150, correct: 15, timeouts: 0 };
      await answerTask(t);
      standing = after;
      await t.check(true);
      expect(t.current()).toBe('uuid-tail');
      expect(t.status()).toBe('open');
    }
  });

  it('does not reject on an old reading when the final read fails', async () => {
    const t = trial();
    await answerTask(t);
    standing = { score: 160, correct: 16, timeouts: 0 };
    await t.check(false);
    standing = null;
    await t.check(true);
    expect(t.current()).toBe('uuid-tail');
  });

  it('ignores a Task when it has no Standing from before it', async () => {
    const t = trial();
    t.observe({ taskId: 't1', encoding: 'uuid-tail', receivedAt: clock });
    standing = { score: 160, correct: 16, timeouts: 0 };
    await t.check(true);
    expect(t.current()).toBe('uuid-tail');
  });

  it('stays on the last candidate once all are rejected', async () => {
    const t = trial();
    for (let i = 0; i < CANDIDATES.length; i++) {
      const before = standing!;
      await answerTask(t, `t${i}`);
      standing = { score: before.score + 10, correct: before.correct + 1, timeouts: 0 };
      await t.check(true);
    }
    expect(t.status()).toBe('exhausted');
    expect(t.current()).toBe('keccak');
    expect(trial().current()).toBe('keccak');
  });

  it('starts over when the configured candidates change', async () => {
    const t = trial();
    await answerTask(t);
    standing = { score: 160, correct: 16, timeouts: 0 };
    await t.check(true);
    expect(trial().current()).toBe('keccak-shr8');
    expect(trial(['ascii', 'sha256']).current()).toBe('ascii');
  });

  it('a single candidate is used as is, with nothing to observe', async () => {
    const t = trial(['keccak']);
    expect(t.status()).toBe('confirmed');
    await answerTask(t);
    standing = { score: 160, correct: 16, timeouts: 0 };
    await t.check(true);
    expect(t.current()).toBe('keccak');
  });
});
