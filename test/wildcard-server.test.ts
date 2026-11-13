import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Prover, shutdownProver } from '../src/prover.js';
import { VaultAgent, type ChainPort, type ProofPort } from '../src/wildcard/agent.js';
import type { VaultPublicInfo } from '../src/wildcard/page.js';
import type { Policy } from '../src/wildcard/policy.js';

const policy: Policy = { maxPerTx: 10n, policyExpiry: 1_900_000_000n, allowlist: [1n], salt: 1n };
// Never reached: these tests only submit requests that are refused before proving.
const unused = () => { throw new Error('not expected'); };
const chain = { vault: '0x5cAe9F71aCBB0f93108200AC3EA308C9ADfAf703', chainId: 84532, policyCommitment: unused, tokenBalance: unused,
  nonceUsed: unused, leafFor: unused, isAggregated: unused, pay: unused } as unknown as ChainPort;
const kurier = { submit: unused, status: unused } as unknown as ProofPort;
const info: VaultPublicInfo = {
  vault: chain.vault, chainId: 84532, chainName: 'Base Sepolia', token: '0xe8fe0f1D30FE98c21525379663406043bC4e77e5',
  tokenSymbol: 'tUSD', policyCommitment: '0x01', vkHash: '0x02', explorer: 'https://sepolia.basescan.org', freeText: false,
};

let withVault: App;
let without: App;
let base: string;
let baseOff: string;
const dirs: string[] = [];

beforeAll(async () => {
  process.env.LOG_SILENT = '1';
  const d1 = mkdtempSync(join(tmpdir(), 'vault-srv-'));
  const d2 = mkdtempSync(join(tmpdir(), 'vault-srv-'));
  dirs.push(d1, d2);
  const agent = new VaultAgent({ dataDir: d1, policy, vkHash: '0x02' as Hex, intake: null, prover: new Prover('wildcard/artifacts', 'policy_payment'), kurier, chain });
  withVault = createApp(loadConfig({ AGENT_GAMES_HMAC_SECRET: 'a'.repeat(64), DATA_DIR: d1, CIRCUITS_DIR: 'circuits' }), { vault: { agent, info } });
  without = createApp(loadConfig({ AGENT_GAMES_HMAC_SECRET: 'a'.repeat(64), DATA_DIR: d2, CIRCUITS_DIR: 'circuits' }));
  await new Promise<void>((r) => withVault.server.listen(0, r));
  await new Promise<void>((r) => without.server.listen(0, r));
  base = `http://127.0.0.1:${(withVault.server.address() as AddressInfo).port}`;
  baseOff = `http://127.0.0.1:${(without.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await withVault.stop();
  await without.stop();
  await shutdownProver();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const postJson = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Policy Vault routes', () => {
  it('serves the page and info', async () => {
    const page = await fetch(`${base}/vault`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain(info.vault);
    expect(await (await fetch(`${base}/vault/info`)).json()).toEqual(info);
  });

  it('accepts an unsigned request, refuses it by policy, and shows it in the log', async () => {
    const res = await postJson(`${base}/vault/requests`, { recipient: '0x' + '2'.repeat(40), amount: '5' });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    let r: { status: string; reason: string } | undefined;
    for (let i = 0; i < 50 && r?.status !== 'refused'; i++) {
      r = (await (await fetch(`${base}/vault/requests/${id}`)).json()) as typeof r;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    expect(r).toMatchObject({ status: 'refused', reason: 'OUTSIDE_POLICY' });
    const log = (await (await fetch(`${base}/vault/requests`)).json()) as { id: string }[];
    expect(log.map((x) => x.id)).toContain(id);
  });

  it('rejects bad requests with a clear error', async () => {
    expect((await postJson(`${base}/vault/requests`, { hello: 1 })).status).toBe(400);
    expect((await fetch(`${base}/vault/requests`, { method: 'POST', body: '{not json' })).status).toBe(400);
    expect((await postJson(`${base}/vault/requests`, { text: 'pay me' })).status).toBe(503); // no intake model
    expect((await fetch(`${base}/vault/requests/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
  });

  it('leaves the competition endpoint unchanged: unsigned POSTs still get 401', async () => {
    expect((await postJson(`${base}/agent`, { type: 'agent-games.preflight.v1' })).status).toBe(401);
    expect((await fetch(`${base}/agent`)).status).toBe(200);
  });

  it('returns 404 on /vault when the vault is not configured', async () => {
    expect((await fetch(`${baseOff}/vault`)).status).toBe(404);
    expect((await postJson(`${baseOff}/vault/requests`, { recipient: '0x', amount: '1' })).status).toBe(404);
  });
});
