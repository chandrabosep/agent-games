// Policy Vault: the public page at GET /vault. Static HTML; the log refreshes from /vault/requests.

export interface VaultPublicInfo {
  vault: string;
  chainId: number;
  chainName: string;
  token: string;
  tokenSymbol: string;
  policyCommitment: string;
  vkHash: string;
  explorer: string;
  freeText: boolean;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderVaultPage(info: VaultPublicInfo): string {
  const addr = (a: string) => `<a href="${esc(info.explorer)}/address/${esc(a)}"><code>${esc(a)}</code></a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Policy Vault</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1c1a; --muted:#6b675f; --line:#e4e0d8; --card:#fff; --accent:#2f5d50; --ok:#2f6b3a; --bad:#9a3b2e; --wait:#8a6d1f; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ecebe7; --muted:#a19d94; --line:#2d2c29; --card:#1d1d1b; --accent:#8cc2b0; --ok:#86c08f; --bad:#e08f80; --wait:#d8b45f; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 32px 0 10px; }
p { margin: 0 0 10px; }
.lede { color: var(--muted); max-width: 70ch; }
a { color: var(--accent); }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
ol.steps { padding-left: 20px; margin: 0; } ol.steps li { margin: 0 0 6px; }
textarea, input { width:100%; font: inherit; color: var(--fg); background: var(--bg); border:1px solid var(--line); border-radius: 8px; padding: 10px; }
textarea { min-height: 110px; resize: vertical; }
button { font: inherit; font-weight: 600; background: var(--accent); color: var(--bg); border: 0; border-radius: 8px; padding: 9px 16px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.row { display:flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
.hint { color: var(--muted); font-size: 13px; }
.table { width:100%; border-collapse: collapse; font-size: 13.5px; }
.table th, .table td { text-align:left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.table th { color: var(--muted); font-weight: 500; font-size: 12px; }
.wrap { overflow-x: auto; }
.s { font-weight: 600; white-space: nowrap; }
.s.paid { color: var(--ok); } .s.refused, .s.failed { color: var(--bad); } .s.wait { color: var(--wait); }
</style></head>
<body><main>
<h1>Policy Vault</h1>
<p class="lede">An accounts-payable agent that can only pay what a <strong>hidden</strong> policy allows. The vault on ${esc(info.chainName)} stores only a hash of the policy: a per-payment limit, an expiry and an allowlist of recipients. For every payment the agent proves in zero knowledge that it fits that policy; zkVerify verifies the proof and the vault checks zkVerify's result before it releases a cent. Even a hijacked agent cannot pay outside the policy, and anyone can audit that every payment was inside it without learning the policy.</p>

<h2>On chain</h2>
<div class="grid">
  <div class="card"><div class="k">Vault</div>${addr(info.vault)}</div>
  <div class="card"><div class="k">Token (${esc(info.tokenSymbol)}, test token)</div>${addr(info.token)}</div>
  <div class="card"><div class="k">Policy commitment (Poseidon)</div><code>${esc(info.policyCommitment)}</code></div>
  <div class="card"><div class="k">zkVerify vkHash (policy circuit)</div><code>${esc(info.vkHash)}</code></div>
</div>

<h2>What happens to a request</h2>
<ol class="steps">
  <li><strong>Read.</strong> ${info.freeText ? 'Claude reads the invoice and extracts recipient, amount and memo. Its output is treated as untrusted.' : 'The request names a recipient and amount.'}</li>
  <li><strong>Decide.</strong> Deterministic code applies the policy's rules. A refusal says only "outside policy", so nobody can probe the limits.</li>
  <li><strong>Prove.</strong> A Groth16 proof that this exact payment (recipient, amount, nonce, deadline, this vault, this chain) fits the committed policy.</li>
  <li><strong>Verify.</strong> zkVerify verifies the proof and aggregates it; the aggregation root is published to ${esc(info.chainName)}.</li>
  <li><strong>Pay.</strong> The vault rebuilds the proof's public inputs itself, checks the leaf against zkVerify's root, and pays once per nonce.</li>
</ol>

<h2>Try it</h2>
<div class="card">
  ${info.freeText
    ? `<label class="k" for="text">Paste an invoice or payment request</label>
  <textarea id="text" maxlength="4000" placeholder="Invoice #1042 from Northwind Hosting. Amount due: 120.00 USDC. Pay to 0x…"></textarea>`
    : `<label class="k" for="recipient">Recipient address</label><input id="recipient" placeholder="0x…">
  <label class="k" for="amount">Amount</label><input id="amount" placeholder="120.00">`}
  <div class="row"><button id="send">Submit request</button><span class="hint" id="msg">Out-of-policy requests are refused before any proof is made. Payments take about 1–4 minutes (zkVerify publishes aggregations on a timer).</span></div>
</div>

<h2>Request log</h2>
<div class="wrap"><table class="table"><thead><tr><th>When (UTC)</th><th>Status</th><th>Payment</th><th>zkVerify</th><th>${esc(info.chainName)}</th></tr></thead>
<tbody id="log"><tr><td colspan="5" class="hint">Loading…</td></tr></tbody></table></div>
<p class="hint" style="margin-top:16px">JSON: <a href="/vault/requests">/vault/requests</a> · <a href="/vault/info">/vault/info</a> · API: <code>POST /vault/requests</code> with <code>{"text": "..."}</code> or <code>{"recipient": "0x…", "amount": "12.50", "memo": "…"}</code></p>
</main>
<script>
const EXPLORER = ${JSON.stringify(info.explorer)};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const short = (h) => h ? esc(h.slice(0, 10)) + '…' : '';
const WAIT = { received: 'queued', reading: 'reading', proving: 'proving', verifying: 'zkVerify', paying: 'paying' };
const REASON = { OUTSIDE_POLICY: 'outside policy', VAULT_BALANCE: 'vault balance too low', INTAKE_UNAVAILABLE: 'could not read request',
  INTAKE_NO_PAYMENT: 'no payment requested', INTAKE_NO_ADDRESS: 'no recipient address', INTAKE_BAD_AMOUNT: 'unclear amount', INTAKE_CURRENCY: 'unsupported currency' };
function row(r) {
  const st = r.status === 'paid' ? '<span class="s paid">paid</span>'
    : r.status === 'refused' ? '<span class="s refused">refused</span><br><span class="hint">' + esc(REASON[r.reason] || r.reason) + '</span>'
    : r.status === 'failed' ? '<span class="s failed">failed</span><br><span class="hint">' + esc((r.error || '').slice(0, 120)) + '</span>'
    : '<span class="s wait">' + esc(WAIT[r.status] || r.status) + '…</span>';
  const pay = r.amount ? esc(r.amount) + ' → <code>' + short(r.recipient) + '</code>' + (r.memo ? '<br><span class="hint">' + esc(r.memo) + '</span>' : '')
    : (r.memo ? '<span class="hint">' + esc(r.memo) + '</span>' : '');
  const zk = r.zkVerifyTxUrl ? '<a href="' + esc(r.zkVerifyTxUrl) + '">proof tx</a>' + (r.aggregationId != null ? '<br><span class="hint">aggregation ' + esc(r.aggregationId) + '</span>' : '') : '';
  const tx = r.payTx && r.payTx.startsWith('0x') && r.payTx.length === 66 ? '<a href="' + EXPLORER + '/tx/' + esc(r.payTx) + '">' + short(r.payTx) + '</a>' + (r.secondsToPaid ? '<br><span class="hint">' + Math.round(r.secondsToPaid) + ' s after proof</span>' : '') : '';
  return '<tr><td>' + esc(r.createdAt.replace('T', ' ').slice(0, 19)) + '</td><td>' + st + '</td><td>' + pay + '</td><td>' + zk + '</td><td>' + tx + '</td></tr>';
}
async function refresh() {
  try {
    const rs = await (await fetch('/vault/requests')).json();
    document.getElementById('log').innerHTML = rs.length ? rs.map(row).join('') : '<tr><td colspan="5" class="hint">No requests yet.</td></tr>';
  } catch {}
}
document.getElementById('send').onclick = async () => {
  const btn = document.getElementById('send'); const msg = document.getElementById('msg');
  const t = document.getElementById('text');
  const body = t ? { text: t.value } : { recipient: document.getElementById('recipient').value, amount: document.getElementById('amount').value };
  btn.disabled = true;
  try {
    const res = await fetch('/vault/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json();
    msg.textContent = res.ok ? 'Request queued: ' + out.id : (out.error || 'Request failed');
    if (res.ok && t) t.value = '';
    refresh();
  } catch { msg.textContent = 'Could not reach the agent.'; }
  btn.disabled = false;
};
refresh(); setInterval(refresh, 5000);
</script>
</body></html>`;
}
