// Deploy PolicyVault to Base Sepolia from the OWNER key, with the agent's address as its only
// `execute` caller, fund it with test tokens, and put the demo drainer on the public blocklist.
// Prints the env lines the agent needs. Testnet only.
//
// Two keys, on purpose: the owner key (WILDCARD_OWNER_KEY) sets the rules and can withdraw, and
// stays on the owner's machine. The agent key (WILDCARD_WALLET_KEY) is the only one the running
// agent holds, so a compromised agent can't loosen the rules or take the funds.
//
// Run from the repo root (after `forge build` in wildcard/contracts):
//   npx tsx --env-file=.env wildcard/scripts/deploy.ts
// Optional: WILDCARD_TOKEN_ADDRESS (reuse a TestUSD; otherwise a new one is deployed),
// WILDCARD_INSTANT_CAP / WILDCARD_DAILY_CAP (whole tokens; default 25 / 500), WILDCARD_DEMO_DRAINER.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { ERC20_ABI, VAULT_ABI } from '../../src/wildcard/chain.js';
import { parsePolicy, policyCommitment } from '../../src/wildcard/policy.js';

const ZKV_PROXY: Address = '0x0807C544D38aE7729f8798388d89Be6502A1e8A8'; // zkVerify aggregation proxy, Base Sepolia
const DOMAIN = 2n; // zkVerify domain that publishes to Base Sepolia
const need = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} missing`); })();
const artifact = (name: string) =>
  JSON.parse(readFileSync(`wildcard/contracts/out/${name}.sol/${name}.json`, 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };

const owner = privateKeyToAccount(need('WILDCARD_OWNER_KEY') as Hex);
const agent = privateKeyToAccount(need('WILDCARD_WALLET_KEY') as Hex).address;
if (owner.address === agent) throw new Error('the owner and agent keys must differ');
const rpc = process.env.WILDCARD_RPC_URL || 'https://sepolia.base.org';
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: baseSepolia, transport: http(rpc), account: owner });
const commitment = policyCommitment(parsePolicy(need('WILDCARD_POLICY')));
const vkHash = need('WILDCARD_VK_HASH') as Hex;
const instantCap = parseUnits(process.env.WILDCARD_INSTANT_CAP || '25', 6);
const dailyCap = parseUnits(process.env.WILDCARD_DAILY_CAP || '500', 6);

const balance = await pub.getBalance({ address: owner.address });
console.log('owner', owner.address, 'balance', balance, 'wei; agent', agent);
if (balance === 0n) throw new Error('fund the owner with Base Sepolia ETH first');
const wait = async (hash: Hex) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  return r;
};

let token = process.env.WILDCARD_TOKEN_ADDRESS as Address | undefined;
if (!token) {
  const tUsd = artifact('TestUSD');
  const h = await wallet.deployContract({ abi: tUsd.abi, bytecode: tUsd.bytecode.object });
  token = (await wait(h)).contractAddress!;
  console.log('TestUSD', token, 'tx', h);
}
const pv = artifact('PolicyVault');
const h2 = await wallet.deployContract({
  abi: pv.abi,
  bytecode: pv.bytecode.object,
  args: [ZKV_PROXY, token, vkHash, DOMAIN, commitment, agent, instantCap, dailyCap],
});
const vault = (await wait(h2)).contractAddress!;
console.log('PolicyVault', vault, 'tx', h2);
const drainer = process.env.WILDCARD_DEMO_DRAINER as Address | undefined;
if (drainer) {
  const h = await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: 'setBlocked', args: [drainer, true] });
  await wait(h);
  console.log('blocklisted demo drainer', drainer, 'tx', h);
}
const h3 = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'mint', args: [vault, parseUnits('100000', 6)] });
await wait(h3);
console.log('minted 100000 tUSD to the vault, tx', h3);
console.log(`\nWILDCARD_VAULT_ADDRESS=${vault}\nWILDCARD_TOKEN_ADDRESS=${token}\nWILDCARD_CHAIN_ID=84532`);
