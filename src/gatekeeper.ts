import { randomBytes } from 'node:crypto';
import { decide } from './checks.js';
import { toCircuitInputs, type TaskIdEncoding } from './encoding.js';
import { log } from './log.js';
import { MalformedInput, parseMode, parseTaskInput, proofRefKey } from './parse.js';
import type { Prover } from './prover.js';
import { REASON_CODES, reasonCodeFor } from './reasonCodes.js';
import type { Store } from './store.js';
import type { TaskInput } from './types.js';

export interface GatekeeperDeps {
  store: Store;
  prover: Prover;
  taskIdEncoding: TaskIdEncoding;
  /** Upper bound on proving time, before the deadline is considered. */
  proofBudgetMs: number;
  /** Margin kept before `deadline_at` for signing and sending. */
  deadlineMarginMs: number;
  now?: () => number;
}

/** A Task's response body, as the exact string that gets signed and sent. */
export class Gatekeeper {
  /** Tasks being answered right now, so a concurrent Retry waits for the same answer. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly deps: GatekeeperDeps) {}

  async handle(envelope: Record<string, unknown>, rawEnvelope: string): Promise<string> {
    const received = this.now();
    const taskId = typeof envelope.task_id === 'string' ? envelope.task_id : null;
    if (taskId === null) {
      log('task.malformed', { error: 'task_id missing' });
      return JSON.stringify({ decision: 'REJECT', reason_code: REASON_CODES.MALFORMED });
    }
    const pending = this.inFlight.get(taskId);
    if (pending) return pending;
    const work = this.answer(taskId, envelope, rawEnvelope, received).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, work);
    return work;
  }

  private async answer(
    taskId: string,
    envelope: Record<string, unknown>,
    rawEnvelope: string,
    received: number,
  ): Promise<string> {
    const mode = parseMode(envelope.mode);
    const rawInput = (envelope.input ?? null) as Record<string, unknown> | null;
    const proofTxEcho = typeof rawInput?.proof_tx === 'string' ? rawInput.proof_tx : undefined;

    let input: TaskInput | null = null;
    let parseError: string | null = null;
    try {
      input = parseTaskInput(rawInput);
    } catch (e) {
      if (!(e instanceof MalformedInput)) throw e;
      parseError = e.message;
    }

    const claim = this.deps.store.claim({
      taskId,
      mode,
      envelope: rawEnvelope,
      proofRef: input ? proofRefKey(input.proofTx) : null,
      salt: BigInt(`0x${randomBytes(31).toString('hex')}`).toString(),
      decide: (alreadySeen) => {
        if (!input) return { decision: 'REJECT', reasonCode: REASON_CODES.MALFORMED };
        const verdict = decide(input, alreadySeen);
        return { decision: verdict.decision, reasonCode: reasonCodeFor(verdict) };
      },
    });

    if (claim.kind === 'existing' && claim.record.responseBody !== null) {
      log('task.retry', { taskId, decision: claim.record.decision });
      return claim.record.responseBody;
    }
    // New Task, or one recorded before a crash but never answered: (re)make the Proof.
    const record = claim.record;
    const decided = this.now();

    const provable = input !== null && record.reasonCode !== REASON_CODES.PROOF_REUSED;
    const body: Record<string, unknown> = { decision: record.decision, reason_code: record.reasonCode };
    let proofError: string | null = provable ? null : 'not a provable task';
    let proveMs = 0;
    let locallyVerified: boolean | null = null;

    if (provable && input) {
      const outcome = await this.deps.prover.prove(
        toCircuitInputs(input, taskId, record.decision, BigInt(record.salt), this.deps.taskIdEncoding),
        this.budget(envelope.deadline_at),
      );
      proveMs = outcome.ok ? outcome.result.ms : outcome.ms;
      if (outcome.ok) {
        body.proof = outcome.result.proof;
        body.public_signals = outcome.result.publicSignals;
        locallyVerified = outcome.result.locallyVerified;
      } else {
        proofError = outcome.error;
      }
    }
    if (proofTxEcho !== undefined) body.proof_tx = proofTxEcho;

    const responseBody = JSON.stringify(body);
    const timings = { decideMs: decided - received, proveMs, totalMs: this.now() - received };
    this.deps.store.complete({ taskId, responseBody, proofAttached: 'proof' in body, proofError, timings });
    log('task.answered', {
      taskId,
      mode,
      decision: record.decision,
      reasonCode: record.reasonCode,
      parseError,
      proofAttached: 'proof' in body,
      locallyVerified,
      proofError,
      ...timings,
    });
    return responseBody;
  }

  /** Proof time budget: the configured cap, shortened so we answer before the deadline. */
  private budget(deadlineAt: unknown): number {
    const deadline = typeof deadlineAt === 'string' ? Date.parse(deadlineAt) : NaN;
    if (Number.isNaN(deadline)) return this.deps.proofBudgetMs;
    return Math.min(this.deps.proofBudgetMs, deadline - this.now() - this.deps.deadlineMarginMs);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

