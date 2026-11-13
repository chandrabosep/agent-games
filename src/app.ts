import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { Gatekeeper } from './gatekeeper.js';
import { candidateKeys, sign, SIGNATURE_HEADER, verify } from './hmac.js';
import { log } from './log.js';
import { Prover } from './prover.js';
import { Store } from './store.js';

const MAX_BODY_BYTES = 1_000_000;
const PREFLIGHT = 'agent-games.preflight.v1';
const GATEKEEPER = 'agent-games.proof-gatekeeper.v1';

export interface App {
  server: Server;
  store: Store;
}

/**
 * Transport: one handler on every path. GET is the health check; POST is
 * HMAC-verified on the raw body, then routed by the body's `type`.
 */
export function createApp(config: Config): App {
  const store = new Store(config.dataDir);
  const gatekeeper = new Gatekeeper({
    store,
    prover: new Prover(config.circuitsDir),
    taskIdEncoding: config.taskIdEncoding,
    proofBudgetMs: config.proofBudgetMs,
    deadlineMarginMs: config.deadlineMarginMs,
  });
  const keys = config.hmacSecret ? candidateKeys(config.hmacSecret) : [];
  if (keys.length === 0) log('config.warning', { message: 'AGENT_GAMES_HMAC_SECRET not set; POSTs will get 401' });

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('request.error', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'internal error' }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
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
    if (envelope.type === GATEKEEPER) {
      return send(res, 200, await gatekeeper.handle(envelope, raw.toString('utf8')), key);
    }
    log('request.unknown_type', { type: envelope.type });
    return send(res, 400, JSON.stringify({ error: 'unknown type' }), key);
  }

  return { server, store };
}

function send(res: ServerResponse, status: number, body: string, key?: Buffer): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
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
