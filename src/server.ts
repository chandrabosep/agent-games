import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { shutdownProver } from './prover.js';

const config = loadConfig();
const { server, store } = createApp(config);

server.listen(config.port, () => {
  log('server.listening', {
    port: config.port,
    dataDir: config.dataDir,
    taskIdEncoding: config.taskIdEncoding,
    hmacConfigured: config.hmacSecret !== '',
  });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('server.stopping', { signal });
    server.close(async () => {
      store.close();
      await shutdownProver();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
