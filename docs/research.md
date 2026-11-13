# zkVerify Agent Games 2026: research notes

Compiled 13 Nov 2026 (IST) from https://agentgames.zkverify.io (every page in the sitemap, plus the
JS bundles that hold the tabbed rules, guide steps and AI prompts) and from local tests of the
published circuits. **Nothing has been registered or submitted.** Everything below came from
public GET requests and offline experiments.

Folder map:
- `docs/raw-pages/`: plain-text dumps of every page. `rules_all_tabs.txt` has all 6 rules sections,
  `guide_all_steps.txt` has all 5 guide steps, and `ai_starter_prompts.txt` has both official "vibecode" prompts.
- `circuits/` (repo root): gatekeeper and vfy-policy `.wasm` and `.zkey` files, exported verification keys, `circuit-info.json`, and SHA256SUMS.
- `scripts/zk-probe/`: the scripts used to reverse-engineer the circuit inputs. Run `npm i` there, then run `node <script>`.

---

## 0. TL;DR and urgency

| | |
|---|---|
| Prize pool | **400,000 VFY**: 100k per track, split **50k / 30k / 20k** for the top 3 |
| Entry | Free. Organised by zkVerify Foundation (built by Horizen Labs) |
| Window | 21 Oct to **21 Nov 2026** (the Games close) |
| Proof Gatekeeper rounds | **12–19 Nov**, one round a day, 12:00–22:00 IST, 8 tasks per round, scores add up. **Round 1 (12 Nov) has already passed. Round 2 is today.** |
| Steal the VFY | **12–16 Nov.** Swiss (5 rounds), then a Top-16 knockout. A strategy commitment is needed **before Swiss Round 1 is paired**, so we may already be late. Check the dashboard. |
| Wildcard / Creator | Submission-based, manually judged, open until 21 Nov |

**Recommended priority with about 8 days left:**
1. **Register today.** It's needed for every track.
2. **Proof Gatekeeper.** The logic is deterministic and fully documented, and the circuit is already worked out (§3.4). Six rounds are left (14–19 Nov) if we're live by tomorrow.
3. **Creator Track.** Cheap to do and runs in parallel: a thread or article about building the Gatekeeper agent.
4. **Wildcard.** Only if there's time. It needs a working agent, a public endpoint and a write-up.
5. **Steal the VFY.** Highest risk: the schedule may already be past pairing, and the policy-circuit parameter format isn't documented (§4.6).

---

## 1. Registration and platform rules (all tracks)

### 1.1 Steps (/guide)
1. **Create an account** at /register by signing in with **X or a wallet** (pick one; it becomes your permanent competition identity). You'll be asked for a public handle, country, short bio, and optionally GitHub and wallet.
2. **Register an agent**: Dashboard → Manage Agents. Add a name and **repo URL** so judges can review it, plus the **full** endpoint path (e.g. `https://x.com/agent`, not just the root).
3. **Rotate Secret**: the platform shows a 32-byte HMAC secret once. Put it in `AGENT_GAMES_HMAC_SECRET`, restart the agent, then **run preflight**. You're only marked active once it passes.
4. **Choose events** during registration or from agent settings.
5. **Practice**: Dashboard → Practice (`/dashboard/practice`). At most 10 dispatches per agent per hour; these don't count toward the score and show the full request and response.

### 1.2 Prize eligibility (Rules 1.1 and 06)
- A connected **GitHub account** (one per competition account) and a connected **wallet address**.
- Winners are verified manually after standings freeze: identity verification, **sanctions screening**, wallet confirmation, and the dispute window closing.
- Get all profile requirements done **before the competition closes**.

### 1.3 Agent rules
- You host it yourself. It needs a public HTTPS endpoint: **no localhost, no private IPs, no custom ports** (so 443 only).
- Any language, model or cloud is allowed.
- Verify `x-agent-games-signature` (HMAC-SHA256, hex) over the **raw request body** before parsing. **Sign every response** over the raw response body with the same secret.
- Task IDs are **idempotency keys**: the platform may retry, so return the same answer for the same task_id.
- **Uptime:** if you're offline you forfeit the task. Free tiers that go to sleep (Render free, etc.) will cost points. Uptime history is public.
- **One GitHub account → one competition account → one agent per event.** Running multiple accounts means **disqualification**. A team uses one account.
- **No manual play.** A human answering tasks is grounds for disqualification.
- Other grounds for disqualification: proof reuse meant to manipulate scores, or probing or attacking the platform infrastructure.

### 1.4 Scoring, disputes and freeze
- The leaderboard is an append-only score ledger, and every change links to a task or match.
- **Disputes:** 72 h from when a score is posted. Open one from the task or match page. Resolution SLA is 5 business days.
- **Score freeze:** after the freeze no new tasks or turns run, and only disputes already open get corrected.
- Prizes are paid in VFY to the profile wallet.

### 1.5 Preflight (all events)
```json
// platform → agent (signed)
{ "type": "agent-games.preflight.v1", "agent_id": "agt_...", "issued_at": "...", "nonce": "abc123" }
// agent → platform (signed with x-agent-games-signature)
{ "ok": true, "protocolVersion": "v1" }
```
A placeholder or mismatched secret fails with a signature error.

---

## 2. Track overview

| Track | Type | How it's judged | Key requirement |
|---|---|---|---|
| Proof Gatekeeper | Automated task arena | Points (deterministic) | Live HTTPS agent and a Groth16 proof per task |
| Steal the VFY | 1v1 tournament | Match points | Strategy commitment and a policy proof per turn |
| Wildcard | Open build | Manual panel | Repo or demo, public endpoint, write-up |
| Creator Track | Content | Manual review | Public posts with #AgentGames, tagging @ZKVProtocol on X |

---

## 3. Proof Gatekeeper (Event 01): best opportunity

**Idea:** the agent is a payment approver. Each task contains a proof that *verifies*, but most tasks are traps.
Approve only when every field agrees.

### 3.1 Format
- 8 scored rounds (12–19 Nov, 12:00–22:00 IST), **8 tasks per agent per round**, so about 64 tasks in total.
- **60 s** to respond, or the task counts as a timeout. Entries lock while a round is open.
- Entry requirements: an account and prize-eligible identity, an HTTPS endpoint with a passing health check, a signed
  preflight, **at least one practice task**, and the ability to answer within 60 s under load.

### 3.2 Task and response
```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_24_9d1", "mode": "competition",
  "issued_at": "...", "deadline_at": "...",
  "input": {
    "registered_vk": "0x7d3a...f291", "proof_vk": "0xa4c1...b8ff",
    "minimum": "1000", "public_balance": "1460",
    "expiry_block": 19842201, "current_block": 19832000,
    "recipient": "0xDe42...9f01", "condition_recipient": "0xDe42...9f01",
    "amount": "500", "max_transfer": "1000",
    "proof_tx": "0xa4c1...8ff1"
  }
}
```
Response (what /build says is required on provable tasks):
```json
{ "decision": "APPROVE|REJECT", "reason_code": "...", "proof": {...groth16...},
  "public_signals": [...], "proof_tx": "0x... (optional audit pointer)" }
```

### 3.3 Decision table (the 7 trap types, with approximate frequency)
Check in this order, failing closed:
| # | Check | Trap / code | Frequency |
|---|---|---|---|
| 1 | Verify the HMAC signature and deadline first | (invalid request → reject) | |
| 2 | `proof_tx` already in the **seen-set**? | `PROOF_REUSED` → REJECT (**no proof needed**, excluded from the bonus) | ~11% |
| 3 | `proof_vk != registered_vk` | `VK_SUBSTITUTION` → REJECT. **Never** verify with proof_vk. | ~13% |
| 4 | `public_balance < minimum` | `THRESHOLD_MISMATCH` → REJECT | ~8% |
| 5 | `current_block >= expiry_block` | `EXPIRED_CONDITION` → REJECT | ~6% |
| 6 | `recipient != condition_recipient` (exact, compared case-insensitively as hex) | `RECIPIENT_MISMATCH` → REJECT | ~6% |
| 7 | `amount > max_transfer` | `AMOUNT_OVERFLOW` → REJECT | ~6% |
| ✓ | All pass | `VALID_CONDITION` → APPROVE, then add proof_tx to the seen-set | ~50% |

Seen-set notes: add the reference **on APPROVE** (the rules) and **record it as seen** on a PROOF_REUSED reject. Store it persistently (DB or file) so a restart doesn't lose it. Also handle retries: the same task_id must return the same cached answer and must **not** be counted as a reuse.

⚠️ **Reason-code inconsistency on the site.** The event page uses `VALID_CONDITION`, `PROOF_REUSED`, `EXPIRED_CONDITION`,
`RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`. The "Canonical reason codes" table in the rules lists `VALID_PROOF`, `PROOF_INVALID`,
`THRESHOLD_MISMATCH`, `PROOF_REPLAY`, `CIRCUIT_MISMATCH`, `VK_SUBSTITUTION`, `PUBLIC_INPUT_MISMATCH`,
`MISSING_VERIFICATION`. **Check which set practice mode accepts** before scored rounds, and ask on Discord. Scoring
seems to be on the decision, but don't rely on that.

### 3.4 Gatekeeper circuit (reverse-engineered locally, verified with snarkjs 0.7.5)
- Groth16 / BN128, Circom 2.x. `vk_hash` on zkVerify mainnet:
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- **13 inputs** (names found by probing the wasm):
  `minimum, publicBalance, amount, maxTransfer, recipient, conditionRecipient, expiryBlock, currentBlock, taskId, salt, decision, registeredVkHash, proofVkHash`
- `decision`: 1 = APPROVE, 0 = REJECT.
- **The circuit only accepts the correct decision.** Proving APPROVE on a trap fails witness generation, and so does
  proving REJECT on a valid condition (tested for VK substitution, threshold, expiry, recipient and overflow).
  So the proof is really a "my decision matches the rules" proof. Reuse isn't in the circuit, which is why PROOF_REUSED needs no proof.
- **13 public signals, in order** (example output):
  `[out0(hash commitment; depends on private salt), registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision, taskId]`
- **Open questions** (settle in practice mode or on Discord):
  - How hex strings such as a 256-bit VK hash or a 160-bit address are encoded into field elements (possibly reduced mod p), and how the string `task_id` like `"gk_24_9d1"` becomes the `taskId` field element. The platform re-checks public signals against the task, so the encoding must match exactly.
  - What out0 is exactly (probably Poseidon over the inputs and salt) and whether the platform cares about it.
  - Whether we must also submit to zkVerify (Kurier) on every task. /build says `proof_tx` is optional and the platform re-verifies the Groth16 proof itself. The rules text says "return your zkVerify transaction reference". Submitting through Kurier on every task is safer if it fits inside 60 s.

### 3.5 Scoring
| Outcome | Points |
|---|---|
| Correct APPROVE / correct REJECT | **+12** |
| Wrong APPROVE (trap approved) | **−6** |
| Wrong REJECT (good one rejected) | −3 |
| Timeout (> 60 s) | −2 |
| Provable task with a missing or invalid Groth16 proof | −2 extra (and no bonus) |
| Reliability bonus per round | +0 to +5, pro-rated by the share of provable tasks whose proof verified |

The best possible round is 8×12 + 5 = **101**. When in doubt, REJECT. Fail closed on errors or timeouts.

### 3.6 Build checklist (from /build §05)
- [ ] Register the full handler path, not the root
- [ ] HMAC secret from Rotate Secret, not a placeholder
- [ ] HMAC verified on the raw body before parsing
- [ ] Every response signed
- [ ] Preflight passes and the agent shows active
- [ ] Responses match the schema
- [ ] Secrets never in logs or LLM prompts
- [ ] Timeouts fail closed
- [ ] Keep proof and tx references for disputes
- [ ] All trap types pass in practice

Architecture advice from the site: keep transport, reasoning, policy checks and formatting separate. **Deterministic code makes
the final decision**; an LLM can explain or log but must never decide. Snarkjs proving with this circuit size (647 wires) takes a second or less.

---

## 4. Steal the VFY (Event 02)

### 4.1 Format
- 12–16 Nov. **Swiss, 5 rounds** (200–300 agents expected; pairing by match points, then balance difference, then opponent strength; no rematches; at most one bye), then a **Top 16 (or 32) single-elimination knockout** seeded by Swiss points.
- Matches take 15–25 min. **20 simultaneous turns**, about **30 s per turn**. Both sides start with **100 simulated VFY**, and the higher balance at the end wins.
- You can redeploy or update the commitment **between rounds**, but it's frozen mid-match. The fact that a commitment changed is public; what changed is not.
- Entry: account, endpoint, signed preflight and practice turn, a **registered strategy commitment** (Dashboard → My Agents → Edit agent → Steal the VFY) **before Swiss Round 1**, and a compatible circuit version. Entries lock once paired.

### 4.2 Actions (resolver v1)
| Action | Cost | Effect |
|---|---|---|
| HOLD | 0 | Nothing. The rules text says it "accumulates a small reserve bonus that slightly increases your next EXTRACT cap" (not in the /build numbers, so check) |
| FORTIFY | 2 VFY | Blocks up to 6 incoming extraction this turn |
| EXTRACT N | 0 | Takes up to N (≤10) from the opponent. A fortified opponent reduces the gain by 6. Both sides can extract at once. |
Resolution is simultaneous and uses only the state at the start of the turn. A missing or invalid response is treated as **HOLD** plus a penalty.

### 4.3 Turn envelope and response
```json
{ "protocolVersion":"v1","eventId":"steal-the-vfy","mode":"competition","matchId":"9f4e1b2a-...","turn":3,
  "issuedAt":"...","deadlineAt":"...",
  "state":{"selfBalance":"95","opponentBalance":"105","selfFortifiedUntilTurn":null,"opponentFortifiedUntilTurn":null},
  "strategyCommitment":{"hash":"0x7d...91"},"resolverVersion":"v1","nonce":"3c2f1a..." }
```
```json
{ "matchId":"9f4e1b2a-...","turn":3,
  "action":{"type":"EXTRACT","amount":5},          // omit "amount" entirely for HOLD/FORTIFY
  "policyProof":{"circuitVersion":"v1","proofReference":"0x..","publicInputsHash":"0x.."},
  "proof":{...},"public_signals":[...],
  "agentTimestamp":"...","idempotencyKey":"<unique per turn>" }
```
publicInputsHash = keccak256 over the following fields, each padded to 32 bytes big-endian, in this exact order:
`commitment, matchId(uuid without dashes, as hex), turn, selfBalance, opponentBalance, action(HOLD=0,FORTIFY=1,EXTRACT=2), amount(0 if none), circuitVersion(1)`.
Common mistakes: a stale matchId or turn, the wrong field order, a circuitVersion that doesn't match the commitment, sending amount with HOLD or FORTIFY, no commitment before R1, reusing an idempotencyKey.

### 4.4 Scoring
Win +18, draw +9, **loss +3**, reliability bonus +0 to +2 per match, timeout 0 to −2. A policy violation costs double a timeout and is visible to everyone.

### 4.5 Policy circuit (found locally)
- vk_hash: `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`, with 9 public signals.
- **17 inputs:** `commitment, matchId, turnNumber, selfBalance, opponentBalance, action, amount, circuitVersion, strategyParams[8], salt`.
- **Commitment = Poseidon(strategyParams[0..7], salt)** (circomlib Poseidon over 9 inputs). Confirmed: that ordering
  passes the commitment check (the circuit's line 72) and the other orderings fail there.
- The circuit then **range-checks the params** (Num2Bits / LessThan / GreaterEqThan) and checks that the action is what
  `policy(params, state)` outputs. **What the 8 params mean isn't published.** All zeros, all ones and 1..8 each
  produced no valid action, so the encoding has to be learned. The site's starter prompt just leaves `STRATEGY_PARAMS`
  as a TODO, so presumably the dashboard or Discord explains it. **Ask on Discord before building this track.**
- The circuit enforces the declared strategy, so strategy design means picking the 8 params well.
  Site hint: "a pure EXTRACT agent is easy to defend against once opponents observe your first round."

---

## 5. Wildcard (Event 03)
- Build any useful agent (payments, training and evaluation, operations, research...). zkVerify is an **optional plus**.
- Submit at `/dashboard/submissions?category=wildcard` with: an **agent link** (repo, demo or write-up), a **public HTTPS
  endpoint**, the **use case** (problem, who it helps, what it does), **build context** (how it works, key decisions), and
  an optional zkVerify claim with a proof reference.
- Judging (manual panel): **useful problem, working implementation, clear explanation, plus verifiability**. Results are
  announced at the closing event.
- Suggested strong angle: **zkTLS**, which proves what web or API data the agent saw, checkable through zkVerify without exposing the payload.

## 6. Creator Track (Event 04)
- Formats: X thread, video (demo, tutorial, walkthrough), article or deep dive, or another post (LinkedIn, Reddit...).
- **Crossposting the same piece to more platforms earns bonus XP**, so add every link.
- Must be original, written by the registrant, and public. **Include #AgentGames in every entry, and on X also tag @ZKVProtocol.**
- Submit at `/dashboard/submissions`. Reviewed manually on **technical substance, clarity, zkVerify relevance, originality**.
- Ideas from the site: announce the 4 tracks and prizes, "can an AI agent back up what it says?", a checklist for trusting
  another agent, a two-agent handshake, a real job where zkVerify helps, a demo of your agent.
  → Our natural piece: **"How I built a Proof Gatekeeper agent (and why the circuit refuses to let you approve a trap)"**.

---

## 7. zkVerify integration

- **Kurier (recommended, REST):** `POST https://api.kurier.xyz/api/v1/submit-proof/<KURIER_API_KEY>` with
  `{proofType:"groth16", vkRegistered:true, proofOptions:{library:"snarkjs",curve:"bn128"}, proofData:{proof, publicSignals, vk:<vkHash>}}`.
  Poll until **Finalized** (Submitted → IncludedInBlock → Finalized). You need a mainnet API key.
- **zkVerifyJS:** direct chain access. Needs a funded account (the site says Volta testnet session).
- Docs: https://docs.zkverify.io/handbook/quickstart, https://docs.zkverify.io/overview/getting-started/kurier,
  https://docs.zkverify.io/architecture/supported_proofs
- Circuit info JSON: https://agentgames.zkverify.io/api/circuit-info

## 8. Links
- Site: https://agentgames.zkverify.io (/events, /build, /guide, /rules, /register, /leaderboard)
- Discord: https://discord.gg/zkverify (ask the open questions here) · X: https://x.com/ZKVProtocol
- Official AI starter prompts for both games: `docs/raw-pages/ai_starter_prompts.txt`

## 9. Questions to ask on Discord before scored play
1. Which reason-code set is canonical (§3.3)?
2. How are hex VKs, addresses and string task_ids encoded into the gatekeeper circuit's field inputs?
3. Is a zkVerify / Kurier submission required for each Gatekeeper task, or is the in-response Groth16 proof enough?
4. Steal the VFY: what do the 8 `strategyParams` mean, and has Swiss Round 1 already been paired (can we still enter)?
5. Does a late Gatekeeper entry still get scored for the remaining rounds? (Scores are cumulative, so missed rounds count as 0.)

## 10. Things only you can do (accounts and secrets)
- Register on /register (X or wallet), and connect GitHub and a wallet.
- Get a Kurier mainnet API key.
- Choose hosting that **stays awake** (Fly.io, Railway, a small VPS or Cloud Run with min-instances=1), not a free tier that sleeps.
- Rotate Secret → set `AGENT_GAMES_HMAC_SECRET`. Never commit it or paste it into chats or LLMs.
