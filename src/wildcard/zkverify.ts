// Policy Vault: zkVerify leaf (statement hash) and a minimal Kurier client.
import { concat, keccak256, sha256, toBytes, type Hex } from 'viem';

const GROTH16 = keccak256(toBytes('groth16'));
/** sha256(""): the pallet's NO_VERSION_HASH; Groth16 has no verifier versions. */
const NO_VERSION_HASH = sha256(new Uint8Array());

/** A public input as zkVerify hashes it: 32 bytes, little-endian. */
function le32(value: bigint): Uint8Array {
  return toBytes(value, { size: 32 }).reverse();
}

/** The leaf zkVerify aggregates for a Groth16 proof; PolicyVault.leafFor computes the same. */
export function groth16Leaf(vkHash: Hex, publicSignals: (bigint | string)[]): Hex {
  const inputs = concat(publicSignals.map((s) => le32(BigInt(s))));
  return keccak256(concat([GROTH16, vkHash, NO_VERSION_HASH, keccak256(inputs)]));
}

export interface AggregationDetails {
  receipt: Hex;
  root: Hex;
  leaf: Hex;
  leafIndex: number;
  numberOfLeaves: number;
  merkleProof: Hex[];
}

export interface KurierJob {
  jobId: string;
  status: string;
  txHash?: string;
  txExplorerUrl?: string;
  aggregationId?: number;
  statement?: Hex;
  aggregationDetails?: AggregationDetails;
  error?: string;
}

/** Statuses after which the proof will not progress further. */
export const KURIER_DONE = new Set(['Aggregated', 'AggregationPublished', 'Failed']);

export class Kurier {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api-testnet.kurier.xyz/api/v1',
  ) {}

  private redact(s: string): string {
    return s.split(this.apiKey).join('<key>');
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const suffix = method === 'GET' && typeof body === 'string' ? `/${body}` : '';
    const res = await fetch(`${this.baseUrl}/${path}/${this.apiKey}${suffix}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(this.redact(`Kurier ${path} ${res.status}: ${text.slice(0, 300)}`));
    return JSON.parse(text);
  }

  /** Registers the VK once; returns zkVerify's vkHash for it. */
  async registerVk(vk: unknown): Promise<Hex> {
    const out = (await this.call('POST', 'register-vk', {
      proofType: 'groth16',
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      vk,
    })) as { vkHash?: Hex; meta?: { vkHash?: Hex } };
    const hash = out.vkHash ?? out.meta?.vkHash;
    if (!hash) throw new Error('Kurier register-vk returned no vkHash');
    return hash;
  }

  /** Submits for verification and aggregation to `chainId`. Returns the job id. */
  async submit(vkHash: Hex, proof: unknown, publicSignals: string[], chainId: number): Promise<string> {
    const out = (await this.call('POST', 'submit-proof', {
      proofType: 'groth16',
      vkRegistered: true,
      chainId,
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      proofData: { proof, publicSignals, vk: vkHash },
    })) as { jobId?: string; optimisticVerify?: string };
    if (!out.jobId) throw new Error('Kurier submit-proof returned no jobId');
    if (out.optimisticVerify && out.optimisticVerify !== 'success') {
      throw new Error(`Kurier rejected the proof (optimisticVerify: ${out.optimisticVerify})`);
    }
    return out.jobId;
  }

  async status(jobId: string): Promise<KurierJob> {
    return (await this.call('GET', 'job-status', jobId)) as KurierJob;
  }
}
