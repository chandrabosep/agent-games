// PROTOTYPE / SPIKE — throwaway. Asks the zkVerify proxy on Base Sepolia whether our aggregated
// statement is accepted, trying a range of domain IDs (Kurier's job status doesn't return one).
// Run: node spike/zkv-onchain-check.mjs spike/out/job-<id>.json
import fs from 'node:fs';
import sha3 from 'js-sha3';

const RPC = process.env.RPC || 'https://sepolia.base.org';
const PROXY = '0x0807C544D38aE7729f8798388d89Be6502A1e8A8'; // Base Sepolia, docs.zkverify.io/architecture/contract-addresses
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).job;
const a = job.aggregationDetails;

const sel = sha3.keccak256('verifyProofAggregation(uint256,uint256,bytes32,bytes32[],uint256,uint256)').slice(0, 8);
const w = (x) => BigInt(x).toString(16).padStart(64, '0');
function calldata(domainId) {
  // head: domainId, aggregationId, leaf, offset(path), leafCount, index ; tail: path length + items
  const head = [w(domainId), w(job.aggregationId), a.leaf.slice(2).padStart(64, '0'), w(6 * 32), w(a.numberOfLeaves), w(a.leafIndex)];
  const tail = [w(a.merkleProof.length), ...a.merkleProof.map((h) => h.slice(2))];
  return '0x' + sel + head.join('') + tail.join('');
}
async function ethCall(data) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: PROXY, data }, 'latest'] }) });
  return r.json();
}
console.log(new Date().toISOString(), 'aggregationId', job.aggregationId, 'leaf', a.leaf);
for (let d = 0; d <= Number(process.env.MAX_DOMAIN || 40); d++) {
  const res = await ethCall(calldata(d));
  const out = res.result ? (BigInt(res.result) === 1n ? 'TRUE' : 'false') : 'revert: ' + (res.error?.message || '').slice(0, 80);
  if (out === 'TRUE' || process.env.VERBOSE) console.log(`domain ${d}: ${out}`);
  if (out === 'TRUE') process.exit(0);
}
console.log('no domain accepted it (yet)');
process.exit(1);
