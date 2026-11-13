// Deploy TestUSD + PolicyVault to Base Sepolia from WILDCARD_WALLET_KEY, fund the vault with
// test tokens, and print the env lines the agent needs. Testnet only.
//
// Run from the repo root (after `forge build` in wildcard/contracts):
//   npx tsx --env-file=.env wildcard/scripts/deploy.ts
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { ERC20_ABI } from '../../src/wildcard/chain.js';
import { parsePolicy, policyCommitment } from '../../src/wildcard/policy.js';

const ZKV_PROXY: Address = '0x0807C544D38aE7729f8798388d89Be6502A1e8A8'; // zkVerify aggregation proxy, Base Sepolia
const DOMAIN = 2n; // zkVerify domain that publishes to Base Sepolia
const need = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} missing`); })();
const artifact = (name: string) =>
  JSON.parse(readFileSync(`wildcard/contracts/out/${name}.sol/${name}.json`, 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };

const account = privateKeyToAccount(need('WILDCARD_WALLET_KEY') as Hex);
const rpc = process.env.WILDCARD_RPC_URL || 'https://sepolia.base.org';
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: baseSepolia, transport: http(rpc), account });
const commitment = policyCommitment(parsePolicy(need('WILDCARD_POLICY')));
const vkHash = need('WILDCARD_VK_HASH') as Hex;

const balance = await pub.getBalance({ address: account.address });
console.log('deployer', account.address, 'balance', balance, 'wei');
if (balance === 0n) throw new Error('fund the deployer with Base Sepolia ETH first');

const tUsd = artifact('TestUSD');
const pv = artifact('PolicyVault');
const h1 = await wallet.deployContract({ abi: tUsd.abi, bytecode: tUsd.bytecode.object });
const token = (await pub.waitForTransactionReceipt({ hash: h1 })).contractAddress!;
console.log('TestUSD', token, 'tx', h1);
const h2 = await wallet.deployContract({ abi: pv.abi, bytecode: pv.bytecode.object, args: [ZKV_PROXY, token, vkHash, DOMAIN, commitment] });
const vault = (await pub.waitForTransactionReceipt({ hash: h2 })).contractAddress!;
console.log('PolicyVault', vault, 'tx', h2);
const h3 = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'mint', args: [vault, parseUnits('100000', 6)] });
await pub.waitForTransactionReceipt({ hash: h3 });
console.log('minted 100000 tUSD to the vault, tx', h3);
console.log(`\nWILDCARD_VAULT_ADDRESS=${vault}\nWILDCARD_TOKEN_ADDRESS=${token}\nWILDCARD_CHAIN_ID=84532`);
