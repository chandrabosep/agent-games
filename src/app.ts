import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { Explainer } from './explainer.js';
import { ExplanationQueue, renderExplanationsPage } from './explanations.js';
import { Gatekeeper } from './gatekeeper.js';
import { candidateKeys, sign, SIGNATURE_HEADER, verify } from './hmac.js';
import { log } from './log.js';
import { Prover } from './prover.js';
import { Store } from './store.js';
import { StealTurns } from './steal/turns.js';
import { SubmitError, type VaultAgent } from './wildcard/agent.js';
import { renderVaultPage, type VaultPublicInfo } from './wildcard/page.js';

const MAX_BODY_BYTES = 1_000_000;
const PREFLIGHT = 'agent-games.preflight.v1';
const GATEKEEPER = 'agent-games.proof-gatekeeper.v1';
const STEAL_EVENT = 'steal-the-vfy';

const EXPLANATIONS_SHOWN = 100;

export interface App {
  server: Server;
  store: Store;
  /** Close the server, let the explainer finish its current Explanation, close the database. */
  stop(): Promise<void>;
}

export interface AppOptions {
  /** Writes explanations in the background; absent means no explanations. */
  explainer?: Explainer;
  /** Wildcard Policy Vault: public routes under /vault; absent means those paths return 404. */
  vault?: { agent: VaultAgent; info: VaultPublicInfo };
}

/**
 * Transport: one handler on every path. GET is the health check; POST is
 * HMAC-verified on the raw body, then routed by the body's `type` (or `eventId` for Steal the VFY).
 */
export function createApp(config: Config, options: AppOptions = {}): App {
  const store = new Store(config.dataDir);
  const explanations = options.explainer ? new ExplanationQueue(store, options.explainer) : null;
  const gatekeeper = new Gatekeeper({
    store,
    prover: new Prover(config.circuitsDir),
    taskIdEncoding: config.taskIdEncoding,
    proofBudgetMs: config.proofBudgetMs,
    deadlineMarginMs: config.deadlineMarginMs,
    onAnswered: explanations ? (task) => explanations.enqueue(task) : undefined,
  });
  const steal = new StealTurns({
    store,
    prover: new Prover(config.circuitsDir, 'vfy-policy'),
    keyring: config.keyring,
    proofBudgetMs: config.stealProofBudgetMs,
    deadlineMarginMs: config.deadlineMarginMs,
  });
  // Responses are signed with whichever key verified the request.
  const keys = [config.hmacSecret, config.stealHmacSecret].filter((s) => s !== '').flatMap(candidateKeys);
  if (keys.length === 0) log('config.warning', { message: 'AGENT_GAMES_HMAC_SECRET not set; POSTs will get 401' });

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('request.error', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'internal error' }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlPath = (req.url ?? '/').split('?')[0];
    // Policy Vault (Wildcard): public, unsigned, and only on /vault paths.
    if (urlPath === '/vault' || urlPath.startsWith('/vault/')) return handleVault(req, res, urlPath);
    if (req.method === 'GET' || req.method === 'HEAD') {
      const path = urlPath;
      if (path === '/explanations.json') {
        return send(res, 200, JSON.stringify(store.recent(EXPLANATIONS_SHOWN)));
      }
      if (path === '/explanations') {
        return send(res, 200, renderExplanationsPage(store.recent(EXPLANATIONS_SHOWN)), undefined, 'text/html; charset=utf-8');
      }
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'method not allowed' }));

    const raw = await readBody(req);
    if (raw === null) return send(res, 413, JSON.stringify({ error: 'body too large' }));

    const header = req.headers[SIGNATURE_HEADER];
    const key = verify(keys, raw, Array.isArray(header) ? header[0] : header);
    if (!key) {
      log('request.unauthorized', { path: req.url, bytes: raw.length });
      return send(res, 401, JSON.stringify({ error: 'invalid signature' }));
    }

    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      envelope = parsed as Record<string, unknown>;
    } catch {
      return send(res, 400, JSON.stringify({ error: 'invalid json' }), key);
    }

    if (envelope.type === PREFLIGHT) {
      log('preflight', { agentId: envelope.agent_id });
      return send(res, 200, JSON.stringify({ ok: true, protocolVersion: 'v1' }), key);
    }
    if (envelope.eventId === STEAL_EVENT) {
      return send(res, 200, await steal.handle(envelope, raw.toString('utf8')), key);
    }
    if (envelope.type === GATEKEEPER) {
      return send(res, 200, await gatekeeper.handle(envelope, raw.toString('utf8')), key);
    }
    log('request.unknown_type', { type: envelope.type });
    return send(res, 400, JSON.stringify({ error: 'unknown type' }), key);
  }

  async function handleVault(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const vault = options.vault;
    if (!vault) return send(res, 404, JSON.stringify({ error: 'Policy Vault is not configured' }));
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/vault' || path === '/vault/') {
        return send(res, 200, renderVaultPage(vault.info), undefined, 'text/html; charset=utf-8');
      }
      if (path === '/vault/info') return send(res, 200, JSON.stringify(vault.info));
      if (path === '/vault/requests') return send(res, 200, JSON.stringify(vault.agent.recent(50)));
      const m = /^\/vault\/requests\/([0-9a-f-]{36})$/.exec(path);
      if (m) {
        const r = vault.agent.get(m[1]);
        return r ? send(res, 200, JSON.stringify(r)) : send(res, 404, JSON.stringify({ error: 'no such request' }));
      }
      return send(res, 404, JSON.stringify({ error: 'not found' }));
    }
    if (req.method === 'POST' && path === '/vault/requests') {
      const raw = await readBody(req);
      if (raw === null || raw.length > 16_000) return send(res, 413, JSON.stringify({ error: 'body too large' }));
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, JSON.stringify({ error: 'invalid json' }));
      }
      try {
        const id = vault.agent.submit(body);
        return send(res, 202, JSON.stringify({ id, status: `/vault/requests/${id}` }));
      } catch (e) {
        if (e instanceof SubmitError) return send(res, e.status, JSON.stringify({ error: e.message }));
        throw e;
      }
    }
    return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
  }

  async function stop(): Promise<void> {
    await new Promise<void>((r) => server.close(() => r()));
    await options.vault?.agent.stop();
    await explanations?.stop();
    store.close();
  }

  return { server, store, stop };
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  key?: Buffer,
  contentType = 'application/json',
): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
  };
  if (key) headers[SIGNATURE_HEADER] = sign(key, body);
  res.writeHead(status, headers).end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
