import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// snarkjs ships no types.
// @ts-expect-error untyped module
import * as snarkjs from 'snarkjs';

export interface ProofResult {
  proof: unknown;
  publicSignals: string[];
  /** Whether the proof verified locally against the circuit's published VK. */
  locallyVerified: boolean;
  ms: number;
}

export type ProveOutcome =
  | { ok: true; result: ProofResult }
  | { ok: false; error: string; ms: number };

export class Prover {
  private readonly wasm: string;
  private readonly zkey: string;
  private readonly vk: unknown;

  /**
   * `circuit` names the artifacts in circuitsDir: gatekeeper (Event 01), vfy-policy (Event 02),
   * or policy_payment (Wildcard, artifacts in wildcard/artifacts).
   */
  constructor(circuitsDir: string, circuit: 'gatekeeper' | 'vfy-policy' | 'policy_payment' = 'gatekeeper') {
    this.wasm = join(circuitsDir, `${circuit}.wasm`);
    this.zkey = join(circuitsDir, `${circuit}_final.zkey`);
    this.vk = JSON.parse(readFileSync(join(circuitsDir, `${circuit}_vk.json`), 'utf8'));
  }

  /**
   * Best effort: never throws, gives up after budgetMs. Gatekeeper: a failed Proof
   * never changes the Decision. Steal the VFY: a failed Policy proof means a Fallback HOLD.
   */
  async prove(inputs: Record<string, string | string[]>, budgetMs: number): Promise<ProveOutcome> {
    const start = Date.now();
    if (budgetMs <= 0) return { ok: false, error: 'no time budget left', ms: 0 };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`proving exceeded ${budgetMs} ms`)), budgetMs);
    });
    try {
      const { proof, publicSignals } = await Promise.race([
        snarkjs.groth16.fullProve(inputs, this.wasm, this.zkey),
        timeout,
      ]);
      const locallyVerified: boolean = await snarkjs.groth16.verify(this.vk, publicSignals, proof);
      return { ok: true, result: { proof, publicSignals, locallyVerified, ms: Date.now() - start } };
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      return { ok: false, error: msg, ms: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Releases snarkjs worker threads (needed for clean test/process exit). */
export async function shutdownProver(): Promise<void> {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  if (curve) await curve.terminate();
}
