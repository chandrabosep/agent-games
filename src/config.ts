import { resolve } from 'node:path';
import { TASK_ID_ENCODINGS, type TaskIdEncoding } from './encoding.js';
import { log } from './log.js';
import { EMPTY_KEYRING, loadKeyring, type Keyring } from './steal/keyring.js';

export interface Config {
  /** Empty until the secret is rotated on the dashboard; POSTs get 401 meanwhile. */
  hmacSecret: string;
  /** A second agent's secret on the same endpoint (Steal the VFY entered as its own agent); empty if none. */
  stealHmacSecret: string;
  port: number;
  dataDir: string;
  circuitsDir: string;
  taskIdEncoding: TaskIdEncoding;
  proofBudgetMs: number;
  deadlineMarginMs: number;
  /** Steal the VFY: the Strategy commitments we can prove against; empty means every Turn gets a Fallback HOLD. */
  keyring: Keyring;
  /** Steal the VFY: proving cap per Turn (the window is about 30 s). */
  stealProofBudgetMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const encoding = (env.TASK_ID_ENCODING ?? 'keccak') as TaskIdEncoding;
  if (!TASK_ID_ENCODINGS.includes(encoding)) {
    throw new Error(`TASK_ID_ENCODING must be one of ${TASK_ID_ENCODINGS.join(', ')}`);
  }
  return {
    hmacSecret: (env.AGENT_GAMES_HMAC_SECRET ?? '').trim(),
    stealHmacSecret: (env.AGENT_GAMES_HMAC_SECRET_STEAL ?? '').trim(),
    port: Number(env.PORT ?? 8080),
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    circuitsDir: resolve(env.CIRCUITS_DIR ?? 'circuits'),
    taskIdEncoding: encoding,
    proofBudgetMs: Number(env.PROOF_BUDGET_MS ?? 45_000),
    deadlineMarginMs: Number(env.DEADLINE_MARGIN_MS ?? 5_000),
    keyring: keyringOrEmpty(env),
    stealProofBudgetMs: Number(env.STEAL_PROOF_BUDGET_MS ?? 20_000),
  };
}

/** A bad Strategy param must not take Gatekeeper down: log it loudly and play Fallback HOLDs. */
function keyringOrEmpty(env: NodeJS.ProcessEnv): Keyring {
  try {
    return loadKeyring(env);
  } catch (e) {
    log('config.error', { message: e instanceof Error ? e.message : String(e) });
    return EMPTY_KEYRING;
  }
}
