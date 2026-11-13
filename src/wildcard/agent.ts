// Policy Vault agent: takes payment requests, decides deterministically, proves, gets the proof
// verified and aggregated by zkVerify, and pays from the vault. One request at a time.
//
//   received → reading → refused
//                      → proving → verifying → paying → paid
//                                                     → failed (any step)
//
// The public log shows every request. A refusal for policy reasons is shown only as
// "outside policy": naming which rule failed would let anyone probe the hidden policy.
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { log } from '../log.js';
import type { ProveOutcome } from '../prover.js';
import type { AggregationDetails, KurierJob } from './zkverify.js';
import { groth16Leaf, KURIER_DONE } from './zkverify.js';
import type { Extracted, Intake } from './intake.js';
import {
  addressToBigint,
  circuitInput,
  policyCommitment,
  refusal,
  type Payment,
  type Policy,
} from './policy.js';

export type Status = 'received' | 'reading' | 'refused' | 'proving' | 'verifying' | 'paying' | 'paid' | 'failed';

/** Why a request was refused. Only the INTAKE_* reasons and OUTSIDE_POLICY are ever shown publicly. */
export type Refusal =
  | 'INTAKE_UNAVAILABLE'
  | 'INTAKE_NO_PAYMENT'
  | 'INTAKE_NO_ADDRESS'
  | 'INTAKE_BAD_AMOUNT'
  | 'INTAKE_CURRENCY'
  | 'VAULT_BALANCE'
  | 'OUTSIDE_POLICY';

export interface VaultRequest {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: Status;
  source: 'text' | 'fields';
  memo: string | null;
  recipient: string | null;
  amount: string | null;
  /** Public refusal reason. */
  reason: Refusal | null;
  nonce: string | null;
  validUntil: number | null;
  kurierJobId: string | null;
  zkVerifyTxUrl: string | null;
  aggregationId: number | null;
  leaf: string | null;
  payTx: string | null;
  error: string | null;
  /** Seconds from submitting the proof to the payment landing. */
  secondsToPaid: number | null;
}

export interface ChainPort {
  readonly vault: Address;
  readonly chainId: number;
  policyCommitment(): Promise<bigint>;
  tokenBalance(): Promise<bigint>;
  nonceUsed(nonce: bigint): Promise<boolean>;
  leafFor(recipient: Address, amount: bigint, nonce: bigint, validUntil: bigint): Promise<Hex>;
  isAggregated(aggregationId: number, d: AggregationDetails): Promise<boolean>;
  pay(
    p: { recipient: Address; amount: bigint; nonce: bigint; validUntil: bigint },
    aggregationId: number,
    d: AggregationDetails,
  ): Promise<{ txHash: Hex; status: 'success' | 'reverted' }>;
}

export interface ProofPort {
  submit(vkHash: Hex, proof: unknown, publicSignals: string[], chainId: number): Promise<string>;
  status(jobId: string): Promise<KurierJob>;
}

export interface ProverPort {
  prove(inputs: Record<string, string | string[]>, budgetMs: number): Promise<ProveOutcome>;
}

export interface AgentDeps {
  dataDir: string;
  policy: Policy;
  vkHash: Hex;
  intake: Intake | null;
  prover: ProverPort;
  kurier: ProofPort;
  chain: ChainPort;
  /** Token decimals (6 for USDC-like tokens). */
  decimals?: number;
  /** How long a proof stays valid for the vault. */
  paymentTtlSeconds?: number;
  pollMs?: number;
  /** Requests accepted per rolling hour, and waiting at once. */
  hourlyLimit?: number;
  queueLimit?: number;
  now?: () => number;
}

const ACCEPTED_CURRENCIES = new Set(['USD', 'USDC', 'TUSD', 'US$', '$']);
const MAX_TEXT = 4000;

export class SubmitError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class VaultAgent {
  private readonly db: Database.Database;
  private readonly decimals: number;
  private readonly ttl: number;
  private readonly pollMs: number;
  private readonly hourlyLimit: number;
  private readonly queueLimit: number;
  private readonly now: () => number;
  private readonly commitment: bigint;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly d: AgentDeps) {
    mkdirSync(d.dataDir, { recursive: true });
    this.db = new Database(join(d.dataDir, 'vault.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      text TEXT,
      fields TEXT,
      memo TEXT, recipient TEXT, amount TEXT,
      reason TEXT, private_reason TEXT,
      nonce TEXT, valid_until INTEGER,
      kurier_job_id TEXT, zkverify_tx_url TEXT, aggregation_id INTEGER, leaf TEXT,
      pay_tx TEXT, error TEXT, submitted_ms INTEGER, seconds_to_paid REAL
    )`);
    this.decimals = d.decimals ?? 6;
    this.ttl = d.paymentTtlSeconds ?? 2 * 3600;
    this.pollMs = d.pollMs ?? 5000;
    this.hourlyLimit = d.hourlyLimit ?? 30;
    this.queueLimit = d.queueLimit ?? 5;
    this.now = d.now ?? Date.now;
    this.commitment = policyCommitment(d.policy);
  }

  /** Our policy's commitment, and whether the vault stores the same one. */
  async selfCheck(): Promise<{ commitment: string; vaultMatches: boolean }> {
    const onChain = await this.d.chain.policyCommitment();
    return { commitment: '0x' + this.commitment.toString(16).padStart(64, '0'), vaultMatches: onChain === this.commitment };
  }

  /** Accepts `{text}` (read by Claude) or `{recipient, amount, memo?}`. Returns the request id. */
  submit(body: unknown): string {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SubmitError(400, 'body must be a JSON object');
    const b = body as Record<string, unknown>;
    let source: 'text' | 'fields';
    let text: string | null = null;
    let fields: string | null = null;
    if (typeof b.text === 'string') {
      if (b.text.trim() === '') throw new SubmitError(400, 'text is empty');
      if (b.text.length > MAX_TEXT) throw new SubmitError(413, `text is longer than ${MAX_TEXT} characters`);
      if (!this.d.intake) throw new SubmitError(503, 'free-text requests are off (no ANTHROPIC_API_KEY); send {recipient, amount}');
      source = 'text';
      text = b.text;
    } else if (typeof b.recipient === 'string' && (typeof b.amount === 'string' || typeof b.amount === 'number')) {
      source = 'fields';
      fields = JSON.stringify({
        recipient: b.recipient.slice(0, 64),
        amount: String(b.amount).slice(0, 40),
        memo: typeof b.memo === 'string' ? b.memo.slice(0, 80) : '',
      });
    } else {
      throw new SubmitError(400, 'send {"text": "..."} or {"recipient": "0x...", "amount": "12.50", "memo": "..."}');
    }

    const hourAgo = new Date(this.now() - 3600_000).toISOString();
    const recent = (this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE created_at > ?').get(hourAgo) as { n: number }).n;
    if (recent >= this.hourlyLimit) throw new SubmitError(429, 'hourly request limit reached; try again later');
    const waiting = (this.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'received'").get() as { n: number }).n;
    if (waiting >= this.queueLimit) throw new SubmitError(429, 'queue is full; try again in a few minutes');

    const id = randomUUID();
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare('INSERT INTO requests (id, created_at, updated_at, status, source, text, fields) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, at, at, 'received', source, text, fields);
    log('vault.request', { id, source });
    this.kick();
    return id;
  }

  get(id: string): VaultRequest | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return row ? toPublic(row) : null;
  }

  recent(limit = 50): VaultRequest[] {
    return (this.db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(toPublic);
  }

  /** Resume after a restart: requests caught mid-flight are retried from their last safe point. */
  start(): void {
    this.db
      .prepare("UPDATE requests SET status = 'received' WHERE status IN ('reading', 'proving') ")
      .run();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
    this.db.close();
  }

  /** Waits for the queue to drain (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const row = this.db
        .prepare("SELECT * FROM requests WHERE status IN ('received', 'verifying', 'paying') ORDER BY created_at LIMIT 1")
        .get() as Row | undefined;
      if (!row) return;
      try {
        await this.process(row);
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : String(e);
        log('vault.failed', { id: row.id, error: msg });
        this.update(row.id, { status: 'failed', error: msg });
      }
    }
  }

  private update(id: string, f: Partial<Record<keyof Row, unknown>>): void {
    const cols = Object.keys(f);
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    this.db
      .prepare(`UPDATE requests SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...cols.map((c) => f[c as keyof Row] as never), new Date(this.now()).toISOString(), id);
  }

  private refuse(id: string, reason: Refusal, privateReason?: string): void {
    log('vault.refused', { id, reason, privateReason });
    this.update(id, { status: 'refused', reason, private_reason: privateReason ?? reason });
  }

  private async process(row: Row): Promise<void> {
    if (row.status === 'received') return this.decideAndProve(row);
    if (row.status === 'verifying' || row.status === 'paying') return this.verifyAndPay(row);
  }

  private async decideAndProve(row: Row): Promise<void> {
    // 1. Read the request.
    this.update(row.id, { status: 'reading' });
    let ex: Extracted | null;
    if (row.source === 'text') {
      ex = await this.d.intake!(row.text ?? '');
      if (!ex) return this.refuse(row.id, 'INTAKE_UNAVAILABLE');
    } else {
      const f = JSON.parse(row.fields ?? '{}') as { recipient: string; amount: string; memo: string };
      ex = { found: true, recipient: f.recipient, amount: f.amount, currency: 'USD', memo: f.memo };
    }
    this.update(row.id, { memo: ex.memo || null });
    if (!ex.found) return this.refuse(row.id, 'INTAKE_NO_PAYMENT');
    if (!/^0x[0-9a-fA-F]{40}$/.test(ex.recipient)) return this.refuse(row.id, 'INTAKE_NO_ADDRESS');
    const amount = parseAmount(ex.amount, this.decimals);
    if (amount === null) return this.refuse(row.id, 'INTAKE_BAD_AMOUNT');
    if (!ACCEPTED_CURRENCIES.has(ex.currency.toUpperCase())) return this.refuse(row.id, 'INTAKE_CURRENCY');
    this.update(row.id, { recipient: ex.recipient, amount: formatAmount(amount, this.decimals) });

    // 2. Decide: deterministic, the circuit's own rules.
    const nonce = BigInt('0x' + randomBytes(8).toString('hex'));
    const validUntil = BigInt(Math.floor(this.now() / 1000) + this.ttl);
    const payment: Payment = {
      recipient: addressToBigint(ex.recipient),
      amount,
      nonce,
      validUntil,
      vault: BigInt(this.d.chain.vault),
      chainId: BigInt(this.d.chain.chainId),
    };
    const why = refusal(this.d.policy, payment);
    if (why) return this.refuse(row.id, 'OUTSIDE_POLICY', why);
    if ((await this.d.chain.tokenBalance()) < amount) return this.refuse(row.id, 'VAULT_BALANCE');

    // 3. Prove, and check that the vault expects exactly this leaf before paying zkVerify to verify it.
    this.update(row.id, { status: 'proving', nonce: nonce.toString(), valid_until: Number(validUntil) });
    const proved = await this.d.prover.prove(circuitInput(this.d.policy, payment), 60_000);
    if (!proved.ok) throw new Error(`proving failed: ${proved.error}`);
    if (!proved.result.locallyVerified) throw new Error('proof did not verify locally');
    const leaf = groth16Leaf(this.d.vkHash, proved.result.publicSignals);
    const vaultLeaf = await this.d.chain.leafFor(ex.recipient as Address, amount, nonce, validUntil);
    if (vaultLeaf.toLowerCase() !== leaf.toLowerCase()) throw new Error(`vault expects leaf ${vaultLeaf}, proof has ${leaf}`);

    // 4. zkVerify.
    const jobId = await this.d.kurier.submit(this.d.vkHash, proved.result.proof, proved.result.publicSignals, this.d.chain.chainId);
    this.update(row.id, { status: 'verifying', kurier_job_id: jobId, leaf, submitted_ms: this.now() });
    log('vault.submitted', { id: row.id, jobId });
    const fresh = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(row.id) as Row;
    return this.verifyAndPay(fresh);
  }

  private async verifyAndPay(row: Row): Promise<void> {
    if (!row.kurier_job_id || !row.recipient || !row.amount || !row.nonce || !row.valid_until) {
      throw new Error('request is missing its proof data');
    }
    const deadline = row.valid_until * 1000;
    let job: KurierJob;
    for (;;) {
      if (this.stopped) return;
      job = await this.d.kurier.status(row.kurier_job_id);
      if (job.txExplorerUrl && job.txExplorerUrl !== row.zkverify_tx_url) {
        this.update(row.id, { zkverify_tx_url: job.txExplorerUrl });
        row.zkverify_tx_url = job.txExplorerUrl;
      }
      if (KURIER_DONE.has(job.status)) break;
      if (this.now() > deadline) throw new Error('payment deadline passed before zkVerify aggregated the proof');
      await sleep(this.pollMs);
    }
    if (job.status === 'Failed' || !job.aggregationDetails || job.aggregationId === undefined) {
      throw new Error(`zkVerify job ended as ${job.status}${job.error ? `: ${job.error}` : ''}`);
    }
    const details = job.aggregationDetails;
    if (row.leaf && details.leaf.toLowerCase() !== row.leaf.toLowerCase()) throw new Error('zkVerify aggregated a different leaf');
    this.update(row.id, { aggregation_id: job.aggregationId });

    // Kurier can report Aggregated a few seconds before the root lands on the vault's chain.
    while (!(await this.d.chain.isAggregated(job.aggregationId, details))) {
      if (this.stopped) return;
      if (this.now() > deadline) throw new Error('payment deadline passed before the root reached the chain');
      await sleep(this.pollMs);
    }

    // After a restart mid-payment the transaction may already have landed.
    if (row.status === 'paying' && (await this.d.chain.nonceUsed(BigInt(row.nonce)))) {
      this.update(row.id, { status: 'paid', error: 'paid; transaction hash not recorded (restart during payment)' });
      return;
    }
    this.update(row.id, { status: 'paying' });
    const amount = parseAmount(row.amount, this.decimals)!;
    const paid = await this.d.chain.pay(
      { recipient: row.recipient as Address, amount, nonce: BigInt(row.nonce), validUntil: BigInt(row.valid_until) },
      job.aggregationId,
      details,
    );
    if (paid.status !== 'success') throw new Error(`pay transaction reverted: ${paid.txHash}`);
    const seconds = row.submitted_ms ? (this.now() - row.submitted_ms) / 1000 : null;
    this.update(row.id, { status: 'paid', pay_tx: paid.txHash, seconds_to_paid: seconds });
    log('vault.paid', { id: row.id, tx: paid.txHash, seconds });
  }
}

interface Row {
  id: string;
  created_at: string;
  updated_at: string;
  status: Status;
  source: 'text' | 'fields';
  text: string | null;
  fields: string | null;
  memo: string | null;
  recipient: string | null;
  amount: string | null;
  reason: Refusal | null;
  private_reason: string | null;
  nonce: string | null;
  valid_until: number | null;
  kurier_job_id: string | null;
  zkverify_tx_url: string | null;
  aggregation_id: number | null;
  leaf: string | null;
  pay_tx: string | null;
  error: string | null;
  submitted_ms: number | null;
  seconds_to_paid: number | null;
}

/** The public view: never the request text or the private refusal reason. */
function toPublic(r: Row): VaultRequest {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status,
    source: r.source,
    memo: r.memo,
    recipient: r.recipient,
    amount: r.amount,
    reason: r.reason,
    nonce: r.nonce,
    validUntil: r.valid_until,
    kurierJobId: r.kurier_job_id,
    zkVerifyTxUrl: r.zkverify_tx_url,
    aggregationId: r.aggregation_id,
    leaf: r.leaf,
    payTx: r.pay_tx,
    error: r.error,
    secondsToPaid: r.seconds_to_paid,
  };
}

/** "120", "120.5", "1250.000000" → smallest units. null for anything else, zero, or too many decimals. */
export function parseAmount(s: string, decimals: number): bigint | null {
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) return null;
  const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return v > 0n ? v : null;
}

export function formatAmount(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
