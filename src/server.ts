import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createClaudeExplainer, EXPLAINER_MODEL } from './explainer.js';
import { log } from './log.js';
import { shutdownProver } from './prover.js';

const config = loadConfig();
// Explanations are optional and off the scoring path: no key, no explanations.
const explainer = process.env.ANTHROPIC_API_KEY
  ? createClaudeExplainer(new Anthropic().beta.messages)
  : undefined;
const { server, stop } = createApp(config, { explainer });

server.listen(config.port, () => {
  log('server.listening', {
    port: config.port,
    dataDir: config.dataDir,
    taskIdEncoding: config.taskIdEncoding,
    hmacConfigured: config.hmacSecret !== '',
    explainer: explainer ? EXPLAINER_MODEL : 'off',
  });
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
