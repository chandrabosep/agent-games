// PROTOTYPE / SPIKE — throwaway. Not part of the agent. Delete or move to a prototype branch.
// Question: how long from submitting a Groth16 proof to zkVerify (via Kurier testnet, aggregation
// to Base Sepolia) until a smart contract can check it with verifyProofAggregation?
// Run: node spike/zkv-aggregation-timing.mjs   (reads KURIER_TESTNET_API_KEY from .env)
import fs from 'node:fs';
import * as snarkjs from 'snarkjs';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const KEY = env.KURIER_TESTNET_API_KEY;
if (!KEY) throw new Error('KURIER_TESTNET_API_KEY missing');
const API = 'https://api-testnet.kurier.xyz/api/v1';
const CHAIN_ID = Number(process.env.CHAIN_ID || 84532); // Base Sepolia
const OUT = 'spike/out';
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${new Date().toISOString()} +${el()}]`, ...a);
const redact = (s) => String(s).split(KEY).join('<key>');

async function call(method, path, body) {
  const r = await fetch(`${API}/${path}/${KEY}${method === 'GET' && body ? '/' + body : ''}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

// 1. Any valid Groth16 proof will do: use the Gatekeeper circuit with a known-good input.
const C = 'circuits/';
const vk = JSON.parse(fs.readFileSync(C + 'gatekeeper_vk.json', 'utf8'));
const input = { minimum: 1000, publicBalance: 1460, amount: 500, maxTransfer: 1000, recipient: 111, conditionRecipient: 111,
  expiryBlock: 19842201, currentBlock: 19832000, taskId: Date.now(), salt: 7, decision: 1, registeredVkHash: 999, proofVkHash: 999 };
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, C + 'gatekeeper.wasm', C + 'gatekeeper_final.zkey');
log('proof generated, local verify =', await snarkjs.groth16.verify(vk, publicSignals, proof), 'publicSignals', publicSignals.length);

// 2. Register the VK (idempotent-ish: on "already registered" the response should carry the hash).
const proofOptions = { library: 'snarkjs', curve: 'bn128' };
let vkHash = env.KURIER_TESTNET_VK_HASH;
if (!vkHash) {
  const reg = await call('POST', 'register-vk', { proofType: 'groth16', proofOptions, vk });
  log('register-vk', reg.status, redact(JSON.stringify(reg.json)).slice(0, 400));
  vkHash = reg.json.vkHash || reg.json.meta?.vkHash;
}
if (!vkHash) throw new Error('no vkHash');
log('vkHash', vkHash);

// 3. Submit with chainId so Kurier aggregates and publishes to the destination chain.
const sub = await call('POST', 'submit-proof', {
  proofType: 'groth16', vkRegistered: true, chainId: CHAIN_ID, proofOptions,
  proofData: { proof, publicSignals, vk: vkHash },
});
log('submit-proof', sub.status, redact(JSON.stringify(sub.json)).slice(0, 400));
const jobId = sub.json.jobId;
if (!jobId) throw new Error('no jobId');
const tSubmit = Date.now();

// 4. Poll and record every status transition.
const transitions = [];
let last = '';
let final;
const deadline = Date.now() + Number(process.env.MAX_MIN || 45) * 60_000;
while (Date.now() < deadline) {
  const s = await call('GET', 'job-status', jobId);
  const st = s.json.status;
  if (st !== last) {
    const since = ((Date.now() - tSubmit) / 1000).toFixed(1);
    transitions.push({ status: st, secondsAfterSubmit: Number(since) });
    log(`status ${last || '(start)'} -> ${st}  (${since}s after submit)`);
    last = st;
    fs.writeFileSync(`${OUT}/job-${jobId}.json`, JSON.stringify({ chainId: CHAIN_ID, vkHash, publicSignals, transitions, job: s.json }, null, 2));
  }
  if (['Aggregated', 'AggregationPublished', 'Failed'].includes(st)) {
    // keep polling briefly past Aggregated to catch AggregationPublished
    if (st !== 'Aggregated' || transitions.some((x) => x.status === 'AggregationPublished')) { final = s.json; break; }
  }
  await new Promise((r) => setTimeout(r, 5000));
}
log('done. transitions:', JSON.stringify(transitions));
log('final job:', redact(JSON.stringify(final ?? last)).slice(0, 2500));
