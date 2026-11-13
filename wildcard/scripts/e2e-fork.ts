// End-to-end test of the Policy Vault against the REAL zkVerify, without spending testnet ETH.
//
// 1. Predicts where the wallet will deploy the vault on Base Sepolia (CREATE address, nonce + 1).
// 2. Proves a payment for that vault, submits it through Kurier testnet, waits until zkVerify has
//    aggregated it and the root is live on the real Base Sepolia zkVerify contract.
// 3. Starts an anvil fork of Base Sepolia, deploys TestUSD + PolicyVault from the same wallet (so
//    the addresses match), and pays. Then checks that a replay and a changed amount both fail.
//
// Run from the repo root: npx tsx --env-file=.env wildcard/scripts/e2e-fork.ts
// Needs: KURIER_TESTNET_API_KEY, WILDCARD_WALLET_KEY, WILDCARD_POLICY; anvil on PATH; forge build in
// wildcard/contracts. Optional: WILDCARD_VK_HASH (skips VK registration).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { Prover, shutdownProver } from '../../src/prover.js';
import { ERC20_ABI, VaultChain, ZKVERIFY_ABI } from '../../src/wildcard/chain.js';
import { bigintToAddress, circuitInput, parsePolicy, refusal, type Payment } from '../../src/wildcard/policy.js';
import { groth16Leaf, Kurier, KURIER_DONE, type KurierJob } from '../../src/wildcard/zkverify.js';

const RPC = 'https://sepolia.base.org';
const ZKV_PROXY: Address = '0x0807C544D38aE7729f8798388d89Be6502A1e8A8'; // Base Sepolia
const DOMAIN = 2n;
const FORK_PORT = 8546;

const need = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} missing`); })();
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const artifact = (name: string) =>
  JSON.parse(readFileSync(`wildcard/contracts/out/${name}.sol/${name}.json`, 'utf8')) as {
    abi: unknown[];
    bytecode: { object: Hex };
  };

const account = privateKeyToAccount(need('WILDCARD_WALLET_KEY') as Hex);
const policy = parsePolicy(need('WILDCARD_POLICY'));
const kurier = new Kurier(need('KURIER_TESTNET_API_KEY'));
const real = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const result: Record<string, unknown> = { startedAt: new Date().toISOString(), wallet: account.address };

// 1. Predict addresses.
const nonce0 = await real.getTransactionCount({ address: account.address });
const tokenAddr = getContractAddress({ from: account.address, nonce: BigInt(nonce0) });
const vaultAddr = getContractAddress({ from: account.address, nonce: BigInt(nonce0 + 1) });
log('wallet', account.address, 'nonce', nonce0, '→ vault will be', vaultAddr);

// 2. Prove a payment for it.
const payment: Payment = {
  recipient: policy.allowlist[0],
  amount: parseUnits('120', 6),
  nonce: BigInt('0x' + randomBytes(8).toString('hex')),
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 3 * 3600),
  vault: BigInt(vaultAddr),
  chainId: BigInt(baseSepolia.id),
};
const refused = refusal(policy, payment);
if (refused) throw new Error(`demo payment refused by policy: ${refused}`);
const prover = new Prover('wildcard/artifacts', 'policy_payment');
const proved = await prover.prove(circuitInput(policy, payment), 60_000);
if (!proved.ok || !proved.result.locallyVerified) throw new Error('proving failed');
log('proved in', proved.result.ms, 'ms');

const vk = JSON.parse(readFileSync('wildcard/artifacts/policy_payment_vk.json', 'utf8'));
const vkHash = (process.env.WILDCARD_VK_HASH as Hex | undefined) ?? (await kurier.registerVk(vk));
log('vkHash', vkHash);
const leaf = groth16Leaf(vkHash, proved.result.publicSignals);

const jobId = await kurier.submit(vkHash, proved.result.proof, proved.result.publicSignals, baseSepolia.id);
const tSubmit = Date.now();
log('Kurier job', jobId);
let job: KurierJob | undefined;
let last = '';
const transitions: { status: string; s: number }[] = [];
for (const deadline = Date.now() + 30 * 60_000; Date.now() < deadline; await sleep(5000)) {
  job = await kurier.status(jobId);
  if (job.status !== last) {
    transitions.push({ status: job.status, s: (Date.now() - tSubmit) / 1000 });
    log('status', job.status);
    last = job.status;
  }
  if (KURIER_DONE.has(job.status)) break;
}
if (!job?.aggregationDetails || job.aggregationId === undefined) throw new Error(`not aggregated: ${job?.status}`);
const details = job.aggregationDetails;
const aggregationId = job.aggregationId;
if (details.leaf.toLowerCase() !== leaf.toLowerCase()) throw new Error(`leaf mismatch: ours ${leaf}, Kurier ${details.leaf}`);
log('aggregation', aggregationId, 'leaf matches ours; leaves', details.numberOfLeaves, 'index', details.leafIndex);

// Wait for the root on the real chain.
let onChain = false;
for (const deadline = Date.now() + 10 * 60_000; Date.now() < deadline && !onChain; ) {
  onChain = await real.readContract({
    address: ZKV_PROXY,
    abi: ZKVERIFY_ABI,
    functionName: 'verifyProofAggregation',
    args: [DOMAIN, BigInt(aggregationId), details.leaf, details.merkleProof, BigInt(details.numberOfLeaves), BigInt(details.leafIndex)],
  });
  if (!onChain) await sleep(5000);
}
if (!onChain) throw new Error('root never appeared on Base Sepolia');
const tLive = (Date.now() - tSubmit) / 1000;
log(`root live on real Base Sepolia, ${tLive.toFixed(1)} s after submit`);
Object.assign(result, { jobId, vkHash, aggregationId, leaf, numberOfLeaves: details.numberOfLeaves, leafIndex: details.leafIndex, zkVerifyTx: job.txExplorerUrl, transitions, secondsSubmitToLiveOnBase: tLive });

// 3. Fork, deploy, pay.
const anvil = spawn('anvil', ['--fork-url', RPC, '--port', String(FORK_PORT), '--silent'], { stdio: 'ignore' });
try {
  const forkRpc = `http://127.0.0.1:${FORK_PORT}`;
  const fork = createPublicClient({ chain: baseSepolia, transport: http(forkRpc) });
  for (let i = 0; i < 60; i++) {
    try { await fork.getBlockNumber(); break; } catch { await sleep(500); }
  }
  await fork.request({ method: 'anvil_setBalance' as never, params: [account.address, '0x56BC75E2D63100000'] as never });
  const wallet = createWalletClient({ chain: baseSepolia, transport: http(forkRpc), account });

  const tUsd = artifact('TestUSD');
  const pv = artifact('PolicyVault');
  const tx1 = await wallet.deployContract({ abi: tUsd.abi, bytecode: tUsd.bytecode.object });
  const r1 = await fork.waitForTransactionReceipt({ hash: tx1 });
  const tx2 = await wallet.deployContract({
    abi: pv.abi,
    bytecode: pv.bytecode.object,
    args: [ZKV_PROXY, tokenAddr, vkHash, DOMAIN, BigInt(proved.result.publicSignals[0])],
  });
  const r2 = await fork.waitForTransactionReceipt({ hash: tx2 });
  if (r1.contractAddress?.toLowerCase() !== tokenAddr.toLowerCase() || r2.contractAddress?.toLowerCase() !== vaultAddr.toLowerCase()) {
    throw new Error('deployed addresses differ from the prediction');
  }
  await wallet.writeContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'mint', args: [vaultAddr, parseUnits('1000', 6)] });
  log('fork: deployed TestUSD', tokenAddr, 'and PolicyVault', vaultAddr);

  const chain = new VaultChain(vaultAddr, baseSepolia.id, forkRpc, need('WILDCARD_WALLET_KEY') as Hex);
  const recipient = bigintToAddress(payment.recipient) as Address;
  const p = { recipient, amount: payment.amount, nonce: payment.nonce, validUntil: payment.validUntil };
  const vaultLeaf = await chain.leafFor(recipient, p.amount, p.nonce, p.validUntil);
  if (vaultLeaf.toLowerCase() !== leaf.toLowerCase()) throw new Error(`vault leaf ${vaultLeaf} != ours ${leaf}`);
  log('vault.leafFor matches our leaf and Kurier\'s');

  const paid = await chain.pay(p, aggregationId, details);
  const bal = await fork.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] });
  log('pay:', paid.status, 'gas', paid.gasUsed, '→ recipient balance', bal);
  if (paid.status !== 'success' || bal !== payment.amount) throw new Error('payment did not arrive');

  const mustFail = async (label: string, f: () => Promise<unknown>) => {
    try { await f(); throw new Error(`${label} succeeded but should have failed`); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('should have failed')) throw e;
      const reason = /NonceAlreadyUsed|ProofNotAggregated|PaymentExpired/.exec(msg)?.[0] ?? msg.split('\n')[0];
      log(`${label}: refused (${reason})`);
      return reason;
    }
  };
  const replay = await mustFail('replay', () => chain.pay(p, aggregationId, details));
  // Fresh nonce, so these reach the proof check instead of stopping at the nonce check.
  const fresh = { ...p, nonce: p.nonce + 1n };
  const bigger = await mustFail('amount changed', () => chain.pay({ ...fresh, amount: p.amount + 1n }, aggregationId, details));
  const other = await mustFail('recipient changed', () => chain.pay({ ...fresh, recipient: bigintToAddress(policy.allowlist[1]) as Address }, aggregationId, details));
  Object.assign(result, { payGasUsed: paid.gasUsed.toString(), negativeChecks: { replay, bigger, other }, ok: true });
} finally {
  anvil.kill();
  await shutdownProver();
}

mkdirSync('wildcard/e2e', { recursive: true });
const file = `wildcard/e2e/fork-${result.startedAt as string}.json`.replace(/:/g, '-');
writeFileSync(file, JSON.stringify(result, null, 2));
log('PASS. Result:', file);
