import type { TaskIdEncoding } from './encoding.js';
import { log } from './log.js';
import type { Store } from './store.js';

/** Our Gatekeeper line on the public leaderboard. */
export interface Standing {
  score: number;
  correct: number;
  timeouts: number;
}

/** Reads our Standing; null when it can't be read. Must never throw. */
export type FetchStanding = () => Promise<Standing | null>;

export type TrialStatus = 'open' | 'confirmed' | 'exhausted';

interface TrialState {
  candidates: TaskIdEncoding[];
  index: number;
  status: TrialStatus;
}

interface Observation {
  taskId: string;
  encoding: TaskIdEncoding;
  baseline: Standing;
  /** A poll saw the Task scored at the no-Proof-credit value; a later poll may still add the credit. */
  sawUncredited: boolean;
  timers: NodeJS.Timeout[];
}

const SETTING_KEY = 'encoding_trial';
/** A correct Decision scores 12 when the platform verifies the Proof and 10 when it doesn't (12 − 2). */
const CREDITED = 12;
const UNCREDITED = 10;
/** The leaderboard rounds scores to one decimal. */
const TOLERANCE = 0.15;

/**
 * The Encoding trial (GLOSSARY): finds the `task_id` encoding whose Proofs the platform credits.
 * It proves each competition Task with the current candidate, then reads our Standing: +12 for
 * that Task confirms the candidate for good, +10 moves on to the next one. Anything else is
 * inconclusive and changes nothing. Off the scoring path, and it never touches a Decision.
 */
export class EncodingTrial {
  private state: TrialState;
  private baseline: { standing: Standing; at: number } | null = null;
  private pending: Observation | null = null;
  private baselineTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly deps: {
      store: Store;
      candidates: TaskIdEncoding[];
      /** Absent: the trial can't observe, so the first candidate is used throughout. */
      fetchStanding?: FetchStanding;
      /** How often the Standing is re-read between Tasks. */
      baselineEveryMs?: number;
      /** When to re-read the Standing after a Task, in ms after it was answered; the last one settles it. */
      pollDelaysMs?: number[];
      now?: () => number;
    },
  ) {
    this.state = this.load();
  }

  /** The encoding to prove the next Task with. */
  current(): TaskIdEncoding {
    return this.state.candidates[this.state.index];
  }

  status(): TrialStatus {
    return this.state.status;
  }

  /** Starts re-reading the Standing in the background while the trial is open. */
  start(): void {
    if (!this.observing()) return;
    void this.refreshBaseline();
    this.baselineTimer = setInterval(() => void this.refreshBaseline(), this.deps.baselineEveryMs ?? 10 * 60_000);
    this.baselineTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.baselineTimer);
    this.pending?.timers.forEach(clearTimeout);
    this.pending = null;
  }

  /** Records our Standing between Tasks, so the next Task's score change can be measured. */
  async refreshBaseline(): Promise<void> {
    if (!this.observing() || this.pending) return;
    const at = this.now();
    const standing = await this.deps.fetchStanding!();
    if (!standing || this.pending || this.stopped) return;
    const before = this.baseline?.standing;
    if (!before || before.score !== standing.score || before.correct !== standing.correct) {
      log('encoding.standing', { ...standing });
    }
    this.baseline = { standing, at };
  }

  /** Call once a competition Task has been answered with a Proof made with `encoding`. */
  observe(task: { taskId: string; encoding: TaskIdEncoding; receivedAt: number }): void {
    if (!this.observing() || this.pending || task.encoding !== this.current()) return;
    if (!this.baseline || this.baseline.at >= task.receivedAt) {
      log('encoding.inconclusive', { taskId: task.taskId, encoding: task.encoding, why: 'no Standing from before the Task' });
      return;
    }
    const delays = this.deps.pollDelaysMs ?? [20_000, 60_000, 3 * 60_000, 8 * 60_000, 15 * 60_000, 20 * 60_000];
    const observation: Observation = {
      taskId: task.taskId,
      encoding: task.encoding,
      baseline: this.baseline.standing,
      sawUncredited: false,
      timers: [],
    };
    observation.timers = delays.map((ms, i) => {
      const timer = setTimeout(() => void this.check(i === delays.length - 1), ms);
      timer.unref();
      return timer;
    });
    this.pending = observation;
  }

  /** Re-reads the Standing for the Task under observation; `final` settles it either way. */
  async check(final: boolean): Promise<void> {
    const obs = this.pending;
    if (!obs) return;
    const standing = await this.deps.fetchStanding!();
    if (this.pending !== obs || this.stopped) return;
    const facts = { taskId: obs.taskId, encoding: obs.encoding };

    if (standing) {
      const scored = standing.correct - obs.baseline.correct;
      const delta = standing.score - obs.baseline.score;
      if (scored > 1 || standing.timeouts !== obs.baseline.timeouts) {
        return this.settle(obs, standing, 'inconclusive', { ...facts, why: 'another Task was scored meanwhile', delta });
      }
      if (scored === 1 && Math.abs(delta - CREDITED) <= TOLERANCE) {
        return this.settle(obs, standing, 'confirmed', { ...facts, delta });
      }
      if (scored === 1) obs.sawUncredited = Math.abs(delta - UNCREDITED) <= TOLERANCE;
      if (final && obs.sawUncredited) return this.settle(obs, standing, 'rejected', { ...facts, delta });
      if (final) return this.settle(obs, standing, 'inconclusive', { ...facts, why: 'score change was neither 10 nor 12', delta, scored });
    } else if (final) {
      // The last read failed: don't reject on an older reading, the credit may have landed since.
      this.settle(obs, null, 'inconclusive', { ...facts, why: 'Standing unreadable' });
    }
  }

  private settle(
    obs: Observation,
    standing: Standing | null,
    outcome: 'confirmed' | 'rejected' | 'inconclusive',
    fields: Record<string, unknown>,
  ): void {
    obs.timers.forEach(clearTimeout);
    this.pending = null;
    this.baseline = standing ? { standing, at: this.now() } : null;
    if (outcome === 'confirmed') {
      this.save({ ...this.state, status: 'confirmed' });
      clearInterval(this.baselineTimer);
    } else if (outcome === 'rejected') {
      const next = this.state.index + 1;
      // Out of candidates: stay on the last one. No candidate was credited, so none is worse.
      if (next < this.state.candidates.length) this.save({ ...this.state, index: next });
      else {
        this.save({ ...this.state, status: 'exhausted' });
        clearInterval(this.baselineTimer);
      }
    }
    log(`encoding.${outcome}`, { ...fields, next: this.current(), status: this.state.status });
  }

  private observing(): boolean {
    return !this.stopped && this.state.status === 'open' && this.deps.fetchStanding !== undefined;
  }

  /** Stored progress, unless the configured candidates changed: a new list starts a new trial. */
  private load(): TrialState {
    const fresh: TrialState = {
      candidates: this.deps.candidates,
      index: 0,
      status: this.deps.candidates.length > 1 ? 'open' : 'confirmed',
    };
    try {
      const stored = JSON.parse(this.deps.store.setting(SETTING_KEY) ?? 'null') as TrialState | null;
      if (
        stored &&
        JSON.stringify(stored.candidates) === JSON.stringify(fresh.candidates) &&
        Number.isInteger(stored.index) &&
        stored.index >= 0 &&
        stored.index < fresh.candidates.length &&
        ['open', 'confirmed', 'exhausted'].includes(stored.status)
      ) {
        return stored;
      }
    } catch {
      // Unreadable state: start over.
    }
    return fresh;
  }

  private save(state: TrialState): void {
    this.state = state;
    this.deps.store.setSetting(SETTING_KEY, JSON.stringify(state));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/** Reads one agent's Gatekeeper Standing from the public leaderboard. Never throws. */
export function leaderboardStanding(url: string, agentId: string, timeoutMs = 10_000): FetchStanding {
  return async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows: unknown = await res.json();
      const row = Array.isArray(rows)
        ? (rows as Record<string, unknown>[]).find((r) => r !== null && typeof r === 'object' && r.agentId === agentId)
        : undefined;
      if (!row) throw new Error('agent not on the leaderboard');
      const { gatekeeper: score, gkCorrect: correct, gkTimeouts: timeouts } = row;
      if (![score, correct, timeouts].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw new Error('unexpected leaderboard row');
      }
      return { score, correct, timeouts } as Standing;
    } catch (e) {
      log('encoding.standing_failed', { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
}
