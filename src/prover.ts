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

/**
 * snarkjs's default bn128 curve starts one worker thread per CPU the host reports, each with its own
 * heap. Render reports 16 CPUs on a 0.5-CPU, 512 MB instance, which took the process from 84 MB to
 * ~490 MB on the first proof and over the limit on 14 Nov. A single-threaded curve stays near
 * 140 MB and uses less CPU in total. Seeding snarkjs's global cache makes prove and verify reuse it.
 */
let curveReady: Promise<void> | undefined;
function ensureSingleThreadCurve(): Promise<void> {
  curveReady ??= (async () => {
    const g = globalThis as { curve_bn128?: unknown };
    if (!g.curve_bn128) g.curve_bn128 = await snarkjs.curves.getCurveFromName('bn128', { singleThread: true });
  })();
  return curveReady;
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
      await ensureSingleThreadCurve();
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

/** Releases the curve (and any snarkjs worker threads) for a clean test/process exit. */
export async function shutdownProver(): Promise<void> {
  const g = globalThis as { curve_bn128?: { terminate(): Promise<void> } | null };
  const curve = g.curve_bn128;
  g.curve_bn128 = null;
  curveReady = undefined;
  if (curve) await curve.terminate();
}
