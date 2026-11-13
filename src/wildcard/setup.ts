// Policy Vault: build the agent from env. Returns undefined (vault off) when it isn't configured
// or the config is bad; a Wildcard problem must never take the Gatekeeper agent down.
import Anthropic from '@anthropic-ai/sdk';
import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';
import { log } from '../log.js';
import { Prover } from '../prover.js';
import { VaultAgent } from './agent.js';
import { chainFor, VaultChain, VaultChainPort } from './chain.js';
import { createClaudeIntake } from './intake.js';
import type { VaultPublicInfo } from './page.js';
import { parsePolicy, policyCommitment } from './policy.js';
import { Kurier } from './zkverify.js';

const KURIER_URL: Record<number, string> = {
  84532: 'https://api-testnet.kurier.xyz/api/v1',
  8453: 'https://api.kurier.xyz/api/v1',
};
const EXPLORER: Record<number, string> = { 84532: 'https://sepolia.basescan.org', 8453: 'https://basescan.org' };

export function loadVault(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): { agent: VaultAgent; info: VaultPublicInfo } | undefined {
  const vault = env.WILDCARD_VAULT_ADDRESS?.trim();
  if (!vault) return undefined;
  try {
    const need = (k: string) => {
      const v = env[k]?.trim();
      if (!v) throw new Error(`${k} is not set`);
      return v;
    };
    const chainId = Number(env.WILDCARD_CHAIN_ID ?? 84532);
    const chain = chainFor(chainId);
    const rpc = env.WILDCARD_RPC_URL?.trim() || chain.rpcUrls.default.http[0];
    const kurierKey = chainId === 8453 ? need('KURIER_API_KEY') : need('KURIER_TESTNET_API_KEY');
    const policy = parsePolicy(need('WILDCARD_POLICY'));
    const vkHash = need('WILDCARD_VK_HASH') as Hex;
    const token = need('WILDCARD_TOKEN_ADDRESS') as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(vault) || !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('bad vault or token address');

    const vaultChain = new VaultChain(vault as Address, chainId, rpc, need('WILDCARD_WALLET_KEY') as Hex);
    const agent = new VaultAgent({
      dataDir,
      policy,
      vkHash,
      intake: env.ANTHROPIC_API_KEY ? createClaudeIntake(new Anthropic().beta.messages) : null,
      prover: new Prover(resolve(env.WILDCARD_ARTIFACTS_DIR ?? 'wildcard/artifacts'), 'policy_payment'),
      kurier: new Kurier(kurierKey, KURIER_URL[chainId]),
      chain: new VaultChainPort(vaultChain, chainId),
    });
    const info: VaultPublicInfo = {
      vault,
      chainId,
      chainName: chain.name,
      token,
      tokenSymbol: env.WILDCARD_TOKEN_SYMBOL?.trim() || 'tUSD',
      policyCommitment: '0x' + policyCommitment(policy).toString(16).padStart(64, '0'),
      vkHash,
      explorer: EXPLORER[chainId],
      freeText: Boolean(env.ANTHROPIC_API_KEY),
    };
    return { agent, info };
  } catch (e) {
    log('vault.config_error', { message: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}
