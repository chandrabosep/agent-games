import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createClaudeExplainer, EXPLAINER_MODEL } from './explainer.js';
import { log } from './log.js';
import { shutdownProver } from './prover.js';
import { commitmentHex } from './steal/keyring.js';
import { loadVault } from './wildcard/setup.js';

const config = loadConfig();
// Explanations are optional and off the scoring path: no key, no explanations.
const explainer = process.env.ANTHROPIC_API_KEY
  ? createClaudeExplainer(new Anthropic().beta.messages)
  : undefined;
// Wildcard Policy Vault: optional, off unless WILDCARD_VAULT_ADDRESS is set.
const vault = loadVault(process.env, config.dataDir);
const { server, stop } = createApp(config, { explainer, vault });

server.listen(config.port, () => {
  log('server.listening', {
    port: config.port,
    dataDir: config.dataDir,
    taskIdEncoding: config.taskIdEncoding,
    hmacConfigured: config.hmacSecret !== '',
    stealHmacConfigured: config.stealHmacSecret !== '',
    explainer: explainer ? EXPLAINER_MODEL : 'off',
    // Public by design (registered on the dashboard); never the Strategy params or Salt.
    stealCommitment: config.keyring.current ? commitmentHex(config.keyring.current) : 'none',
    stealPreviousCommitment: config.keyring.previous ? commitmentHex(config.keyring.previous) : 'none',
    vault: vault ? vault.info.vault : 'off',
  });
  if (vault) {
    vault.agent.start();
    vault.agent
      .selfCheck()
      .then((c) => log(c.vaultMatches ? 'vault.ready' : 'vault.commitment_mismatch', c))
      .catch((e) => log('vault.selfcheck_failed', { error: e instanceof Error ? e.message : String(e) }));
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('server.stopping', { signal });
    void stop()
      .then(shutdownProver)
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
