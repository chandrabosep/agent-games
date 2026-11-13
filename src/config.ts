import { resolve } from 'node:path';
import { TASK_ID_ENCODINGS, type TaskIdEncoding } from './encoding.js';

export interface Config {
  /** Empty until the secret is rotated on the dashboard; POSTs get 401 meanwhile. */
  hmacSecret: string;
  port: number;
  dataDir: string;
  circuitsDir: string;
  taskIdEncoding: TaskIdEncoding;
  proofBudgetMs: number;
  deadlineMarginMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const encoding = (env.TASK_ID_ENCODING ?? 'keccak') as TaskIdEncoding;
  if (!TASK_ID_ENCODINGS.includes(encoding)) {
    throw new Error(`TASK_ID_ENCODING must be one of ${TASK_ID_ENCODINGS.join(', ')}`);
  }
  return {
    hmacSecret: (env.AGENT_GAMES_HMAC_SECRET ?? '').trim(),
    port: Number(env.PORT ?? 8080),
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    circuitsDir: resolve(env.CIRCUITS_DIR ?? 'circuits'),
    taskIdEncoding: encoding,
    proofBudgetMs: Number(env.PROOF_BUDGET_MS ?? 45_000),
    deadlineMarginMs: Number(env.DEADLINE_MARGIN_MS ?? 5_000),
  };
}
