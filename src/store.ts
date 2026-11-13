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

export interface RecentTask {
  taskId: string;
  mode: Mode;
  receivedAt: string;
  decision: Decision;
  reasonCode: string;
  proofAttached: boolean;
  input: Record<string, unknown> | null;
  explanation: string | null;
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
      CREATE TABLE IF NOT EXISTS steal_turns (
        turn_key      TEXT PRIMARY KEY,
        mode          TEXT NOT NULL,
        answered_at   TEXT NOT NULL,
        envelope      TEXT NOT NULL,
        response_body TEXT NOT NULL
      );
    `);
    // Added after v1 shipped: migrate an existing database in place.
    const columns = new Set((this.db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name));
    if (!columns.has('explanation')) this.db.exec('ALTER TABLE tasks ADD COLUMN explanation TEXT');
    if (!columns.has('explained_at')) this.db.exec('ALTER TABLE tasks ADD COLUMN explained_at TEXT');
  }

  setExplanation(taskId: string, explanation: string): void {
    this.db
      .prepare('UPDATE tasks SET explanation = ?, explained_at = ? WHERE task_id = ?')
      .run(explanation, new Date().toISOString(), taskId);
  }

  /** Most recent answered Tasks, newest first, for the public explanations page. */
  recent(limit: number): RecentTask[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, mode, received_at, envelope, decision, reason_code, proof_attached, explanation
         FROM tasks WHERE response_body IS NOT NULL ORDER BY received_at DESC LIMIT ?`,
      )
      .all(limit) as {
      task_id: string;
      mode: Mode;
      received_at: string;
      envelope: string;
      decision: Decision;
      reason_code: string;
      proof_attached: number | null;
      explanation: string | null;
    }[];
    return rows.map((r) => {
      let input: Record<string, unknown> | null = null;
      try {
        const env = JSON.parse(r.envelope) as { input?: unknown };
        if (typeof env.input === 'object' && env.input !== null) input = env.input as Record<string, unknown>;
      } catch {
        input = null;
      }
      return {
        taskId: r.task_id,
        mode: r.mode,
        receivedAt: r.received_at,
        decision: r.decision,
        reasonCode: r.reason_code,
        proofAttached: r.proof_attached === 1,
        input,
        explanation: r.explanation,
      };
    });
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

  /** Steal the VFY: the exact body sent for a Turn, so a Retry gets it back unchanged. */
  stealResponse(turnKey: string): string | null {
    const row = this.db.prepare('SELECT response_body FROM steal_turns WHERE turn_key = ?').get(turnKey) as
      | { response_body: string }
      | undefined;
    return row?.response_body ?? null;
  }

  /** Records a Turn's body unless one is already stored; returns the body that is stored. */
  saveStealResponse(args: { turnKey: string; mode: string; envelope: string; responseBody: string }): string {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO steal_turns (turn_key, mode, answered_at, envelope, response_body)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(args.turnKey, args.mode, new Date().toISOString(), args.envelope, args.responseBody);
    return this.stealResponse(args.turnKey) ?? args.responseBody;
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
