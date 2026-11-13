import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { log } from '../log.js';
import { parseMode } from '../parse.js';
import type { Prover } from '../prover.js';
import type { Store } from '../store.js';
import type { Mode } from '../types.js';
import type { Keyring, KeyringEntry } from './keyring.js';
import { ACTION, ACTION_NAMES, policy, UINT16_MAX, type Play } from './policy.js';

/** The circuit version as the response writes it and as the circuit and publicInputsHash encode it. */
const CIRCUIT_VERSION = { wire: 'v1', field: 1n } as const;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export interface StealDeps {
  store: Store;
  prover: Prover;
  keyring: Keyring;
  /** Upper bound on proving time; past it the Turn gets a Fallback HOLD. */
  proofBudgetMs: number;
  /** Margin kept before `deadlineAt` for signing and sending. */
  deadlineMarginMs: number;
  now?: () => number;
}

interface Turn {
  matchId: string;
  turnNumber: number;
  mode: Mode;
  selfBalance: number;
  opponentBalance: number;
}

/**
 * One response body per Turn (GLOSSARY: Turn), as the exact string that gets
 * signed and sent. No language model is involved and Strategy params are never logged.
 */
export class StealTurns {
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly deps: StealDeps) {}

  async handle(envelope: Record<string, unknown>, rawEnvelope: string): Promise<string> {
    const received = this.now();
    const turn = parseTurn(envelope);
    if (!turn) {
      log('turn.malformed', { matchId: envelope.matchId, turn: envelope.turn });
      return JSON.stringify(fallbackBody(envelope.matchId, envelope.turn, received));
    }
    const turnKey = turnKeyOf(turn.matchId, turn.turnNumber);
    const stored = this.deps.store.stealResponse(turnKey);
    if (stored !== null) {
      log('turn.retry', { matchId: turn.matchId, turn: turn.turnNumber });
      return stored;
    }
    const pending = this.inFlight.get(turnKey);
    if (pending) return pending;
    const work = this.answer(turn, turnKey, envelope, rawEnvelope, received).finally(() => this.inFlight.delete(turnKey));
    this.inFlight.set(turnKey, work);
    return work;
  }

  private async answer(
    turn: Turn,
    turnKey: string,
    envelope: Record<string, unknown>,
    rawEnvelope: string,
    received: number,
  ): Promise<string> {
    const entry = this.entryFor(envelope, turn);
    let body = fallbackBody(turn.matchId, turn.turnNumber, received);
    let fallback: string | null = null;
    let locallyVerified: boolean | null = null;
    let proveMs = 0;
    let play: Play = { action: ACTION.HOLD, amount: 0 };

    if (!entry) {
      fallback = 'unknown commitment';
    } else {
      play = policy(entry.params, turn);
      const outcome = await this.deps.prover.prove(circuitInputs(entry, turn, play), this.budget(envelope.deadlineAt, received));
      proveMs = outcome.ok ? outcome.result.ms : outcome.ms;
      if (outcome.ok) {
        locallyVerified = outcome.result.locallyVerified;
        body = {
          ...body,
          action: play.action === ACTION.EXTRACT ? { type: 'EXTRACT', amount: play.amount } : { type: ACTION_NAMES[play.action] },
          policyProof: { circuitVersion: CIRCUIT_VERSION.wire, publicInputsHash: publicInputsHash(entry, turn, play) },
          proof: outcome.result.proof,
          public_signals: outcome.result.publicSignals,
          agentTimestamp: new Date(this.now()).toISOString(),
        };
      } else {
        fallback = `policy proof failed: ${outcome.error}`;
      }
    }

    const responseBody = this.deps.store.saveStealResponse({
      turnKey,
      mode: turn.mode,
      envelope: rawEnvelope,
      responseBody: JSON.stringify(body),
    });
    log('turn.answered', {
      matchId: turn.matchId,
      turn: turn.turnNumber,
      mode: turn.mode,
      action: fallback ? 'HOLD' : ACTION_NAMES[play.action],
      fallback,
      policyProofAttached: 'proof' in body,
      locallyVerified,
      proveMs,
      totalMs: this.now() - received,
    });
    return responseBody;
  }

  /** The Keyring entry named by the envelope; a practice Turn with no commitment uses the current one. */
  private entryFor(envelope: Record<string, unknown>, turn: Turn): KeyringEntry | undefined {
    const named = (envelope.strategyCommitment as { hash?: unknown } | null | undefined)?.hash;
    if ((named === null || named === undefined) && turn.mode === 'practice') return this.deps.keyring.current;
    const entry = this.deps.keyring.find(named);
    if (!entry) {
      // Loud on purpose: every Turn of this Match will be a Fallback HOLD until the Keyring has this commitment.
      log('turn.unknown_commitment', { matchId: turn.matchId, turn: turn.turnNumber, strategyCommitment: named });
    }
    return entry;
  }

  private budget(deadlineAt: unknown, received: number): number {
    const deadline = typeof deadlineAt === 'string' ? Date.parse(deadlineAt) : NaN;
    const cap = received + this.deps.proofBudgetMs - this.now();
    if (Number.isNaN(deadline)) return cap;
    return Math.min(cap, deadline - this.now() - this.deps.deadlineMarginMs);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function parseTurn(envelope: Record<string, unknown>): Turn | null {
  const { matchId, turn, state } = envelope;
  if (typeof matchId !== 'string' || !UUID.test(matchId)) return null;
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) return null;
  const s = state as Record<string, unknown> | null | undefined;
  const selfBalance = balance(s?.selfBalance);
  const opponentBalance = balance(s?.opponentBalance);
  if (selfBalance === null || opponentBalance === null) return null;
  return { matchId, turnNumber: turn, mode: parseMode(envelope.mode), selfBalance, opponentBalance };
}

function balance(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= UINT16_MAX ? n : null;
}

function turnKeyOf(matchId: unknown, turnNumber: unknown): string {
  return `${String(matchId).toLowerCase()}:${String(turnNumber)}`;
}

function matchIdField(matchId: string): bigint {
  return BigInt(`0x${matchId.replace(/-/g, '')}`);
}

function circuitInputs(entry: KeyringEntry, turn: Turn, play: Play): Record<string, string | string[]> {
  return {
    commitment: entry.commitment.toString(),
    matchId: matchIdField(turn.matchId).toString(),
    turnNumber: String(turn.turnNumber),
    selfBalance: String(turn.selfBalance),
    opponentBalance: String(turn.opponentBalance),
    action: String(play.action),
    amount: String(play.amount),
    circuitVersion: CIRCUIT_VERSION.field.toString(),
    strategyParams: [...entry.params, 0, 0, 0, 0].map(String),
    salt: entry.salt.toString(),
  };
}

/** /build: keccak256 over eight 32-byte big-endian words, in this order. */
function publicInputsHash(entry: KeyringEntry, turn: Turn, play: Play): string {
  const words = [
    entry.commitment,
    matchIdField(turn.matchId),
    BigInt(turn.turnNumber),
    BigInt(turn.selfBalance),
    BigInt(turn.opponentBalance),
    BigInt(play.action),
    BigInt(play.amount),
    CIRCUIT_VERSION.field,
  ].map((v) => v.toString(16).padStart(64, '0'));
  return `0x${Buffer.from(keccak_256(Buffer.from(words.join(''), 'hex'))).toString('hex')}`;
}

/** RFC 4122 URL namespace; any fixed namespace works, it only has to stay the same. */
const UUID_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

/**
 * A name-based UUID v5 of matchId and turn number only: stable across Retries,
 * unique per Turn, whatever was played. The platform's schema requires a valid UUID.
 */
function idempotencyKey(matchId: unknown, turnNumber: unknown): string {
  const name = Buffer.from(`steal-the-vfy:${turnKeyOf(matchId, turnNumber)}`, 'utf8');
  const b = createHash('sha1').update(Buffer.concat([UUID_NAMESPACE, name])).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** GLOSSARY: Fallback HOLD — never an unproven EXTRACT or FORTIFY. */
function fallbackBody(matchId: unknown, turnNumber: unknown, received: number): Record<string, unknown> {
  return {
    matchId,
    turn: turnNumber,
    action: { type: 'HOLD' },
    policyProof: { circuitVersion: CIRCUIT_VERSION.wire },
    agentTimestamp: new Date(received).toISOString(),
    idempotencyKey: idempotencyKey(matchId, turnNumber),
  };
}
