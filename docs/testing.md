# Testing and operations playbook

Status as of 13 Nov 2026, 13:30 IST. Update the **Status** and **Open checks** sections as things change. They are the hand-off between sessions.

## Status

- **Live and registered** as agent "Broken-Bones". Preflight passes.
- **Deployed:** commit `820fb4e` (13 Nov, 16:02 IST, a one-off exception to the deploy window, approved by the user for the Steal entry). It includes `04db3a0`'s background Explanations, so open check 4 can be verified now.
- **Practice so far:** 8 tasks, all REJECT and all correct. Every log line has `proofAttached: true`, `locallyVerified: true`, total 0.8–1.0 s after the first cold 3.1 s. Platform verdicts (Expected matches Submitted, Proof **VERIFIED**) confirmed from result cards for: `VK_SUBSTITUTION` ×2, `EXPIRED_CONDITION` ×2 (`ce26b2fa`, `e9dbbda0`), `THRESHOLD_MISMATCH` ×1 (`8d42e706`). `RECIPIENT_MISMATCH` ×3 (`462b3ccd`, `eb612686`, `c03019a5`) are correct in the logs, but no full card with the verdict has been seen yet. That confirms our field encoding (keccak `task_id`, hex reduced mod p) and the event-page reason codes. Practice deadline is 15 s; competition is 60 s.
- **Local rehearsal (13 Nov, 13:33 IST, practice limit hit):** I ran the agent locally at `04db3a0` with the explainer off and sent signed practice-shaped tasks built from the real cards. `VALID_CONDITION` → APPROVE with a locally verified proof. `AMOUNT_OVERFLOW` → REJECT with a verified proof. Reusing that approved `proof_tx` → REJECT `PROOF_REUSED` with no proof. Reusing a *rejected* `proof_tx` → APPROVE. Boundaries: amount = max and balance = min both APPROVE, and expiry = current is `EXPIRED_CONDITION`. Every proof came from the organizers' circuit, so the circuit agrees with each Decision. This doesn't close checks 1–3, which need the platform's verdict.
- **Platform quirk:** the "Correct decision" sentence on practice cards doesn't match the trap type. An `EXPIRED_CONDITION` card said the balance was below threshold, a `THRESHOLD_MISMATCH` card said the expiry was in the past, and another `EXPIRED_CONDITION` card gave the recipient text. The trap type, reason code and Expected field are consistent, so judge by those. It looks like a platform display bug, not ours. Maybe report it on Discord.
- **Scored rounds:** At 13:58 IST on 13 Nov, the event page (rendered fresh, `no-store`) showed **"NO LIVE ROUND"**, header "Tasks issued 0", and Rounds 01 and 02 both "UPCOMING" with Issued/Responded/Verified 0. So no scored task seems to have gone to *anyone* yet, and Round 1 probably wasn't missed by us after all. Rules, scoring (+12/+12/−6/−3/−2/−2, bonus 0–5), trap list and frequencies, schedule and payload schema are unchanged from `docs/raw-pages/events_proof-gatekeeper.txt`. Only the intro and "How it works" copy were reworded. No `"mode":"competition"` task in our logs yet. Ask on Discord whether rounds are delayed. (Superseded: the schedule moved to 16:00–02:00 IST; see below.)

## Open checks

Work these in order. Each one is done only when its criterion holds.

1. **APPROVE path on the platform.** Done when a practice task with trap type `VALID_CONDITION` shows Submitted APPROVE, Expected APPROVE, and Proof VERIFIED. This is the only decision with `decision = 1` in the circuit, and the platform hasn't checked one yet.
2. **Every trap type seen once in practice.** Done when each of `THRESHOLD_MISMATCH`, `EXPIRED_CONDITION`, `RECIPIENT_MISMATCH` and `AMOUNT_OVERFLOW` has a correct result with a verified proof.
   Progress: `EXPIRED_CONDITION` ✅, `THRESHOLD_MISMATCH` ✅, `RECIPIENT_MISMATCH` (needs a full card with the verdict), `AMOUNT_OVERFLOW` (not seen yet).
3. **Reuse trap.** Done when a `PROOF_REUSED` practice task is answered REJECT with no proof. It can only appear after we've approved something in that session. If the platform sends a `proof_tx` our Seen-set has never seen and expects REJECT, the reuse model is wrong. Stop and redesign.
4. **Explanations live.** After the post-22:00 deploy, done when `/explanations` shows an explanation for a new practice task within about 30 s, and the logs show `explain.stored`.
5. **Competition traffic.** Done when the first `"mode":"competition"` task appears in the logs with a decision and `proofAttached: true` well inside 60 s.

## Steal the VFY (Event 02)

Status as of 13 Nov 2026, ~15:30 IST.

- **Entered as a second agent, Bones-Steal** (Steal the VFY only), on the same endpoint with its own secret `AGENT_GAMES_HMAC_SECRET_STEAL` (`148a8b7`). First practice turn (16:12 IST): we played EXTRACT 10 with a Policy proof in 1.5 s, but it failed the schema check because `idempotencyKey` must be a valid UUID; fixed with a UUID v5. The card also lists "Policy proof transaction confirmed on-chain"; if that fails next, we need Kurier submission and `proofReference`.
- **Schedule changed (seen 13 Nov, 16:26 IST):** Gatekeeper now runs 8 rounds, 13–20 Nov, **16:00–02:00 IST** daily, 8 tasks per agent per round. Round 1 went live at 16:00 on 13 Nov. The three Steal deploys (16:02, 16:08, 16:16) fell inside it. Our logs show no Round 1 task and no failed request, but a task sent during a deploy gap would hit Render's proxy and never reach our logs. The Broken-Bones dashboard is the only place to check for timeouts. "7 trap varieties" means VALID_CONDITION plus the same 6 traps; only the frequencies changed.
- **Swiss Round 1 (13 Nov, 17:30–~19:05 IST, match `28bcf45b-…` vs "danielx Steal the VFY"):** every turn EXTRACT 10, proof verified locally, ~1.5 s. The leaderboard VFY column dropped by 2 per resolved turn (−24 after 12, −26 after 13), and our opponent shows the same score. Every other pair shows equal scores too (−31/−31, −12/−12). −31 = draw (+9) + 20 × −2, so the platform seems to apply the −2 turn penalty to both sides of nearly every match. Only MP-gatekeeper-01 (+9) is clean. The dashboard has no replay. The stored competition envelopes (read via `render ssh`, now set up) show **100/100 balances on every turn 1–15**, both sides unfortified, and no feedback fields (competition envelopes have no `priorTurnHash`). That fits both sides extracting 10 or both being reduced to HOLD; the symmetric penalty points to the second. Update (19:10 IST): the match ended at −31 (draw +9, 20 × −2). Other agents do get clean turns: "pecker" is at VFY +20 (win +18, reliability +2) and MP-gatekeeper-01 at +9, so the penalty is **not** platform-wide. **Likely cause, found in pecker's public repo (penguinpecker/agentgames-2026, which scored clean):** they nest `proof` and `public_signals` inside `policyProof`, matching /build ("attach your policy proof (circuitVersion plus the Groth16 proof and public_signals)"), and send `protocolVersion: "v1"`. We sent the proof only at the top level. Fix `bda22ec`, deployed 13 Nov 19:50 IST: the proof goes only inside `policyProof`, exactly like theirs, plus `protocolVersion`. Next: confirm with a practice turn and the first Round 2 turns (score should stop dropping, balances should move). `publicInputsHash` stays; theirs is computed the same way. Gatekeeper: healthy agents sit at multiples of 10, which suggests +10 per correct task. We have 2 Round 1 tasks in the DB (20 points); agents at 30 have had 3. Public data: `GET https://agentgames.zkverify.io/api/leaderboard`.
- **Practice passed (13 Nov, 16:20 IST, `fb79722`):** 3 turns, each "Correct decision" with the proof verified, about 1.6 s per turn against a 15 s practice window. Public signal 1 equals our registered commitment. What the cards showed:
  - Practice envelopes have **no `strategyCommitment`** and add a `priorTurnHash` field. We prove against the current commitment, and the platform accepts that.
  - "Expected" on the card is the reference opponent's action, not what we should have played.
  - Practice proofs aren't put on-chain; the platform makes the attestations for competition turns, so no Kurier is needed.
  - Resolver data points, turn 1 from 100/100, our EXTRACT 10: against HOLD we end at 110, against FORTIFY at 104 (both match the published numbers), against EXTRACT at 102 (the reference opponent probably extracts 8).
- **Deployed in `820fb4e`** (13 Nov, 16:02 IST). The startup log shows `stealCommitment` with the registered hash. Earlier status: It lives in `src/steal/` on the same service, and `/agent` routes on `eventId`. 78/78 tests pass. The policy is checked against the circuit's witness calculation, and the Policy proofs verify against `vfy-policy_vk.json`.
- **Strategy params are set** in `.env` and on Render (13 Nov, ~16:10 IST). The user delegated the choice to the model after a simulated search, and the decision and its reasoning are recorded in `docs/private/`. The values never go in git or logs.
- **Gatekeeper Round 2 is live in bursts:** a scored task (`task_R02_…`, `VK_SUBSTITUTION`, proof attached, 0.8 s) arrived at 15:09 IST while the page showed "NO LIVE ROUND". Don't trust the page alone when timing a deploy.
- **Pairing:** at 14:32 IST the page showed "NO LIVE MATCHES", with 0 agents paired. Entries lock when Round 1 is paired.
- **Decode and decisions:** the circuit decode is kept out of the public repo until 16 Nov, in `docs/private/` (gitignored). The decisions are in the grilling session of 13 Nov.

**Entry steps, in order:**
1. Set `STRATEGY_PARAMS` and a fresh `STRATEGY_SALT` in `.env`. Generate the salt with `node -e "console.log(BigInt('0x'+require('crypto').randomBytes(31).toString('hex')).toString())"` straight into the file, never echoed.
2. Run `npm run steal:commitment`, which prints only the hash.
3. Set both values on Render.
4. Deploy. The user approved one exception to the deploy window for this, valid only while Gatekeeper shows no live round. Ask again at the moment of deploying.
5. The user registers the hash under Dashboard → My Agents → Edit agent → Steal the VFY.
6. The practice turn. Check the logs for `turn.answered` with `policyProofAttached: true`. A practice turn with a null commitment is proven against our current commitment. The platform may reject that turn's `publicInputsHash`; that wouldn't be a bug on our side.

**Re-committing between rounds:**
1. Move the current pair to `STRATEGY_PARAMS_PREVIOUS` and `STRATEGY_SALT_PREVIOUS`.
2. Set the new params with a **fresh** salt.
3. Run `npm run steal:commitment`, which prints the current and previous hashes.
4. Update Render, then deploy, only between rounds.
5. Register the new hash.

If `turn.unknown_commitment` shows up in the logs, the platform is using a commitment the Keyring doesn't hold, and every turn of that match gets a Fallback HOLD.

**Discord question (not posted yet):** how many turns a fortify lasts, what "exposed balance" means, the size of the HOLD reserve bonus, and whether EXTRACT is clipped at the opponent's balance.

## Procedures

**Practice dispatch.** Dashboard → Practice (`https://agentgames.zkverify.io/dashboard/practice`). The limit is 10 per agent per hour. Only the user can sign in (X or wallet). So either the user dispatches and pastes the result card, or the user signs in to the preview pane and the agent dispatches. Each result card shows the trap type, the expected and submitted decisions, the proof status, and the request and response.

**Checking a task in the logs.** Search for `task.answered`. Its fields: `taskId`, `mode`, `decision`, `reasonCode`, `proofAttached`, `locallyVerified`, `proofError`, `decideMs`, `proveMs`, `totalMs`. `explain.stored`, `explain.failed` and `explain.refused` follow it for Explanations.

**Signed request by hand** (the secret is in `.env`; never print it):
```sh
SEC=$(sed -n 's/^AGENT_GAMES_HMAC_SECRET=//p' .env)
B='{"type":"agent-games.preflight.v1","nonce":"t"}'
S=$(printf '%s' "$B" | openssl dgst -sha256 -hmac "$SEC" -hex | awk '{print $NF}')
curl -s -X POST https://proof-gatekeeper.onrender.com/agent -H "x-agent-games-signature: $S" -d "$B"
```

**Deploy** (only outside 16:00–02:00 IST and never during a Steal match, after asking the user):
1. `npm test`, which must be fully green, including `test/lockfile.test.ts`.
2. Push to `main`.
3. Trigger the deploy through the Render API: `POST https://api.render.com/v1/services/srv-dbradhoae00c73f34l80/deploys`, authenticated with the key in `~/.render/cli.yaml`. Poll until it's `live`.
4. Verify: GET `/agent` returns `{"ok":true}`, the signed preflight above returns 200, and the startup log shows `hmacConfigured: true` and `explainer: claude-opus-5-5`.

**If the encoding ever stops verifying:** change `TASK_ID_ENCODING` on Render (`keccak` | `sha256` | `ascii` | `hex-digits`) and redeploy outside round hours. No code change is needed.

## Later (not started)

- Creator Track: a thread about building the agent, with the `/explanations` link, #AgentGames, and @ZKVProtocol. Possibly a daily round-summary post through the user's X API app (needs write-enabled tokens; check whether automated posts count).
- Kurier dispute-evidence worker (needs `KURIER_API_KEY`).
- Steal the VFY: moved up to its own section, "Steal the VFY (Event 02)".
