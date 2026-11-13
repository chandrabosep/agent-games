import { poseidon9 } from 'poseidon-lite';
import { UINT16_MAX, type StrategyParams } from './policy.js';

/** BN254 scalar field order; the Salt must be below it. */
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface KeyringEntry {
  params: StrategyParams;
  salt: bigint;
  commitment: bigint;
}

export interface Keyring {
  current?: KeyringEntry;
  /** The commitment before the latest re-commit, kept while a Match paired under it may still run. */
  previous?: KeyringEntry;
  /** The entry whose Strategy commitment equals the envelope's `strategyCommitment.hash`. */
  find(strategyCommitment: unknown): KeyringEntry | undefined;
}

/**
 * Strategy params and Salt come only from env (GLOSSARY: Strategy params).
 * Errors name the variable, never its value.
 */
export function loadKeyring(env: NodeJS.ProcessEnv): Keyring {
  const current = entryFrom(env, 'STRATEGY_PARAMS', 'STRATEGY_SALT');
  const previous = entryFrom(env, 'STRATEGY_PARAMS_PREVIOUS', 'STRATEGY_SALT_PREVIOUS');
  const entries = [current, previous].filter((e): e is KeyringEntry => e !== undefined);
  return {
    current,
    previous,
    find(strategyCommitment) {
      const value = parseCommitment(strategyCommitment);
      return value === null ? undefined : entries.find((e) => e.commitment === value);
    },
  };
}

function entryFrom(env: NodeJS.ProcessEnv, paramsVar: string, saltVar: string): KeyringEntry | undefined {
  const rawParams = env[paramsVar]?.trim();
  const rawSalt = env[saltVar]?.trim();
  if (!rawParams && !rawSalt) return undefined;
  if (!rawParams) throw new Error(`${paramsVar} must be set together with ${saltVar}`);
  if (!rawSalt) throw new Error(`${saltVar} must be set together with ${paramsVar}`);

  const values = rawParams.split(',').map((s) => s.trim());
  if (values.length !== 4 && values.length !== 8) throw new Error(`${paramsVar} must have 4 (or 8) comma-separated values`);
  if (!values.every((v) => /^\d+$/.test(v))) throw new Error(`${paramsVar} values must be non-negative integers`);
  const n = values.map(Number);
  if (n.slice(4).some((v) => v !== 0)) throw new Error(`${paramsVar} reserved values 5-8 must be 0`);
  const [amount, fortifyBelow, extractAbove, extractDisabled] = n;
  if (amount < 1 || amount > 10) throw new Error(`${paramsVar} value 1 (extract amount) must be 1-10`);
  if (fortifyBelow > UINT16_MAX || extractAbove > UINT16_MAX) {
    throw new Error(`${paramsVar} values 2-3 (thresholds) must be 0-${UINT16_MAX}`);
  }
  if (extractDisabled !== 0 && extractDisabled !== 1) throw new Error(`${paramsVar} value 4 (extract disabled) must be 0 or 1`);

  if (!/^\d+$/.test(rawSalt)) throw new Error(`${saltVar} must be a decimal integer`);
  const salt = BigInt(rawSalt);
  if (salt >= FIELD) throw new Error(`${saltVar} must be below the BN254 field size`);

  const params: StrategyParams = [amount, fortifyBelow, extractAbove, extractDisabled as 0 | 1];
  const commitment = poseidon9([...params.map(BigInt), 0n, 0n, 0n, 0n, salt]);
  return { params, salt, commitment };
}

/** A Strategy commitment as the dashboard and the envelope write it: 0x + 64 hex digits. */
export function commitmentHex(entry: KeyringEntry): string {
  return `0x${entry.commitment.toString(16).padStart(64, '0')}`;
}

export const EMPTY_KEYRING: Keyring = { find: () => undefined };

function parseCommitment(hash: unknown): bigint | null {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(hash)) return null;
  return BigInt(hash);
}
