import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Decision, Mode } from './types.js';

export interface TaskRecord {
  taskId: string;
  mode: Mode;
  decision: Decision;
  reasonCode: string;
  salt: string;
  /** Exact response body sent; null while the Proof is still being made. */
  responseBody: string | null;
}

export type Claim =
  | { kind: 'existing'; record: TaskRecord }
  | { kind: 'new'; record: TaskRecord };

interface TaskRow {
  task_id: string;
  mode: Mode;
  decision: Decision;
  reason_code: string;
  salt: string;
  response_body: string | null;
}

/**
 * SQLite on the persistent disk: the Seen-set (per Mode), the response cache
 * (task_id → exact body, so Retries get identical answers), and the logs and
 * Dispute evidence for every Task.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'gatekeeper.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id       TEXT PRIMARY KEY,
        mode          TEXT NOT NULL,
        received_at   TEXT NOT NULL,
        envelope      TEXT NOT NULL,
        decision      TEXT NOT NULL,
        reason_code   TEXT NOT NULL,
        salt          TEXT NOT NULL,
        response_body TEXT,
        proof_attached INTEGER,
        proof_error   TEXT,
        timings       TEXT,
        completed_at  TEXT
      );
      CREATE TABLE IF NOT EXISTS seen (
        mode        TEXT NOT NULL,
        proof_ref   TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        PRIMARY KEY (mode, proof_ref)
      );
    `);
  }

  /**
   * Atomically: return the cached Task if this is a Retry; otherwise look up
   * the Seen-set, decide, add the Proof reference on APPROVE, and record the
   * Task as pending. `decide` must be synchronous and pure.
   */
  claim(args: {
    taskId: string;
    mode: Mode;
    envelope: string;
    proofRef: string | null;
    salt: string;
    decide: (alreadySeen: boolean) => { decision: Decision; reasonCode: string };
  }): Claim {
    const tx = this.db.transaction((): Claim => {
      const row = this.db
        .prepare('SELECT task_id, mode, decision, reason_code, salt, response_body FROM tasks WHERE task_id = ?')
        .get(args.taskId) as TaskRow | undefined;
      if (row) return { kind: 'existing', record: toRecord(row) };

      const alreadySeen =
        args.proofRef !== null &&
        this.db.prepare('SELECT 1 FROM seen WHERE mode = ? AND proof_ref = ?').get(args.mode, args.proofRef) !==
          undefined;
      const { decision, reasonCode } = args.decide(alreadySeen);
      const now = new Date().toISOString();
      if (decision === 'APPROVE' && args.proofRef !== null) {
        this.db
          .prepare('INSERT INTO seen (mode, proof_ref, task_id, approved_at) VALUES (?, ?, ?, ?)')
          .run(args.mode, args.proofRef, args.taskId, now);
      }
      this.db
        .prepare(
          `INSERT INTO tasks (task_id, mode, received_at, envelope, decision, reason_code, salt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(args.taskId, args.mode, now, args.envelope, decision, reasonCode, args.salt);
      return {
        kind: 'new',
        record: { taskId: args.taskId, mode: args.mode, decision, reasonCode, salt: args.salt, responseBody: null },
      };
    });
    return tx.immediate();
  }

  complete(args: {
    taskId: string;
    responseBody: string;
    proofAttached: boolean;
    proofError: string | null;
    timings: Record<string, number>;
  }): void {
    this.db
      .prepare(
        `UPDATE tasks SET response_body = ?, proof_attached = ?, proof_error = ?, timings = ?, completed_at = ?
         WHERE task_id = ? AND response_body IS NULL`,
      )
      .run(
        args.responseBody,
        args.proofAttached ? 1 : 0,
        args.proofError,
        JSON.stringify(args.timings),
        new Date().toISOString(),
        args.taskId,
      );
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    mode: row.mode,
    decision: row.decision,
    reasonCode: row.reason_code,
    salt: row.salt,
    responseBody: row.response_body,
  };
}
