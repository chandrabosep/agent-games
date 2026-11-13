// Policy Vault: reads and writes on the vault's chain (Base Sepolia for the demo).
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import type { AggregationDetails } from './zkverify.js';

export const VAULT_ABI = parseAbi([
  'function zkVerify() view returns (address)',
  'function token() view returns (address)',
  'function vkHash() view returns (bytes32)',
  'function domainId() view returns (uint256)',
  'function owner() view returns (address)',
  'function policyCommitment() view returns (uint256)',
  'function nonceUsed(uint256) view returns (bool)',
  'function leafFor(address recipient, uint256 amount, uint256 nonce, uint256 validUntil) view returns (bytes32)',
  'function pay(address recipient, uint256 amount, uint256 nonce, uint256 validUntil, uint256 aggregationId, bytes32[] merklePath, uint256 leafCount, uint256 index)',
  'function setPolicy(uint256 commitment)',
  'event Paid(uint256 indexed nonce, address indexed recipient, uint256 amount, uint256 aggregationId, bytes32 leaf)',
  'error NotOwner()',
  'error NotFieldElement()',
  'error PaymentExpired()',
  'error NonceAlreadyUsed()',
  'error ProofNotAggregated()',
  'error TransferFailed()',
]);

export const ZKVERIFY_ABI = parseAbi([
  'function verifyProofAggregation(uint256 domainId, uint256 aggregationId, bytes32 leaf, bytes32[] merklePath, uint256 leafCount, uint256 index) view returns (bool)',
]);

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function mint(address to, uint256 amount)',
]);

export function chainFor(chainId: number): Chain {
  if (chainId === baseSepolia.id) return baseSepolia;
  if (chainId === base.id) return base;
  throw new Error(`unsupported chain ${chainId}`);
}

export interface VaultInfo {
  zkVerify: Address;
  token: Address;
  vkHash: Hex;
  domainId: bigint;
  owner: Address;
  policyCommitment: bigint;
}

export class VaultChain {
  readonly publicClient: PublicClient;
  readonly wallet: WalletClient;
  readonly account: PrivateKeyAccount;
  readonly chain: Chain;

  constructor(
    readonly vault: Address,
    chainId: number,
    rpcUrl: string,
    privateKey: Hex,
  ) {
    this.chain = chainFor(chainId);
    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ chain: this.chain, transport: http(rpcUrl), account: this.account });
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.publicClient.readContract({
      address: this.vault,
      abi: VAULT_ABI,
      functionName,
      args,
    } as never) as Promise<T>;
  }

  async info(): Promise<VaultInfo> {
    const [zkVerify, token, vkHash, domainId, owner, policyCommitment] = await Promise.all([
      this.read<Address>('zkVerify'),
      this.read<Address>('token'),
      this.read<Hex>('vkHash'),
      this.read<bigint>('domainId'),
      this.read<Address>('owner'),
      this.read<bigint>('policyCommitment'),
    ]);
    return { zkVerify, token, vkHash, domainId, owner, policyCommitment };
  }

  nonceUsed(nonce: bigint): Promise<boolean> {
    return this.read<boolean>('nonceUsed', [nonce]);
  }

  leafFor(recipient: Address, amount: bigint, nonce: bigint, validUntil: bigint): Promise<Hex> {
    return this.read<Hex>('leafFor', [recipient, amount, nonce, validUntil]);
  }

  /** Whether zkVerify's root for this aggregation has landed on the vault's chain. */
  isAggregated(info: VaultInfo, aggregationId: number, d: AggregationDetails): Promise<boolean> {
    return this.publicClient.readContract({
      address: info.zkVerify,
      abi: ZKVERIFY_ABI,
      functionName: 'verifyProofAggregation',
      args: [info.domainId, BigInt(aggregationId), d.leaf, d.merkleProof, BigInt(d.numberOfLeaves), BigInt(d.leafIndex)],
    });
  }

  /** Sends `pay` (simulated first, so a revert costs no gas) and waits for the receipt. */
  async pay(
    p: { recipient: Address; amount: bigint; nonce: bigint; validUntil: bigint },
    aggregationId: number,
    d: AggregationDetails,
  ): Promise<{ txHash: Hex; status: 'success' | 'reverted'; gasUsed: bigint }> {
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.vault,
      abi: VAULT_ABI,
      functionName: 'pay',
      args: [
        p.recipient,
        p.amount,
        p.nonce,
        p.validUntil,
        BigInt(aggregationId),
        d.merkleProof,
        BigInt(d.numberOfLeaves),
        BigInt(d.leafIndex),
      ],
    });
    const txHash = await this.wallet.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    return { txHash, status: receipt.status, gasUsed: receipt.gasUsed };
  }
}

/** VaultChain as the agent's ChainPort; reads the vault's fixed settings once. */
export class VaultChainPort {
  private infoP: Promise<VaultInfo> | null = null;

  constructor(
    private readonly c: VaultChain,
    readonly chainId: number,
  ) {}

  get vault(): Address {
    return this.c.vault;
  }

  private info(): Promise<VaultInfo> {
    this.infoP ??= this.c.info().catch((e) => {
      this.infoP = null;
      throw e;
    });
    return this.infoP;
  }

  async policyCommitment(): Promise<bigint> {
    return (await this.c.info()).policyCommitment;
  }

  async tokenBalance(): Promise<bigint> {
    const { token } = await this.info();
    return this.c.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.c.vault] });
  }

  nonceUsed(nonce: bigint): Promise<boolean> {
    return this.c.nonceUsed(nonce);
  }

  leafFor(recipient: Address, amount: bigint, nonce: bigint, validUntil: bigint): Promise<Hex> {
    return this.c.leafFor(recipient, amount, nonce, validUntil);
  }

  async isAggregated(aggregationId: number, d: AggregationDetails): Promise<boolean> {
    return this.c.isAggregated(await this.info(), aggregationId, d);
  }

  pay(
    p: { recipient: Address; amount: bigint; nonce: bigint; validUntil: bigint },
    aggregationId: number,
    d: AggregationDetails,
  ): Promise<{ txHash: Hex; status: 'success' | 'reverted' }> {
    return this.c.pay(p, aggregationId, d);
  }
}
