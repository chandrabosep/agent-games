# zkVerify Agent Games 2026 agent

Our entry for [zkVerify Agent Games](https://agentgames.zkverify.io): **Proof Gatekeeper** (Event 01) and
**Steal the VFY** (Event 02), served by one agent. Vocabulary: [GLOSSARY-MAP.md](GLOSSARY-MAP.md) lists each event's glossary.

## Proof Gatekeeper agent (v1)

A Node/TypeScript HTTPS service. The platform POSTs signed Tasks; the agent returns a signed
Decision, a Reason code, and (on Provable tasks) a Groth16 Proof from the official circuit.

| Module | Job |
|---|---|
| `src/checks.ts` | The Checks: pure, fixed order, first failure names the Trap |
| `src/parse.ts` | Task input → exact bigints; malformed input is rejected |
| `src/reasonCodes.ts` | The only place reason-code strings live (swap the set here) |
| `src/encoding.ts` | Task values → circuit field elements (`task_id` scheme is **unconfirmed**) |
| `src/prover.ts` | snarkjs proving with a time budget; never throws, never changes the Decision |
| `src/store.ts` | SQLite: Seen-set per Mode, response cache for Retries, task logs and evidence |
| `src/gatekeeper.ts` | One Task end to end |
| `src/app.ts` | Transport: GET health check, HMAC on the raw body, routing by `type` (Steal: `eventId`), signed responses |
| `src/explainer.ts` | Claude (Opus 5.5) writes a plain-language Explanation of a Decision; returns null on any failure |
| `src/explanations.ts` | Background queue for Explanations, and the public `/explanations` page |
| `src/steal/policy.ts` | Steal the VFY: the vfy-policy circuit's rule, mirrored exactly (tested against the circuit) |
| `src/steal/keyring.ts` | Steal the VFY: Strategy params + Salt from env → Strategy commitments we can prove against |
| `src/steal/turns.ts` | Steal the VFY: one Turn end to end: Action, Policy proof, publicInputsHash, Fallback HOLD, Retries |
| `scripts/steal-commitment.ts` | `npm run steal:commitment`: prints the commitment to register, never the params or Salt |

Steal the VFY plays whatever Strategy params the user sets in env; no model chooses or sees them, and no
language model is involved in a Turn. An unprovable Turn gets a Fallback HOLD, never an unproven Action.

Rules Gatekeeper follows: the Decision comes only from the Checks (a failed Proof costs 2 points, a wrong
REJECT costs 3); only approved Proof references go in the Seen-set; Retries get the identical body;
`proof_tx` is echoed back; no Kurier call while answering. An LLM never decides: with
`ANTHROPIC_API_KEY` set, Claude writes an Explanation *after* each response is sent, shown at
`/explanations` (HTML) and `/explanations.json`. Without the key the agent runs unchanged.

```sh
npm install
npm test          # checks, real proofs verified against circuits/gatekeeper_vk.json, end-to-end HTTP
npm run dev       # local, reads env from your shell (see .env.example)
npm run build && npm start
```

Deploy: `render.yaml` (Render Starter + 1 GB disk at `/var/data`). Set `AGENT_GAMES_HMAC_SECRET`
after Rotate Secret, then run preflight. Don't deploy while a round is open (12:00–22:00 IST).

**Still to settle in practice mode:** the `task_id` → field encoding (`TASK_ID_ENCODING`), how hex
values are encoded, and which reason-code set is accepted.

## Other folders

- `docs/research.md`: everything known about the competition (rules, schemas, scoring, circuit findings, open questions)
- `docs/raw-pages/`: text snapshots of the official site
- `circuits/`: official Groth16 circuit artifacts (wasm, zkey, exported verification keys, SHA256SUMS)
- `scripts/zk-probe/`: local scripts used to reverse-engineer the circuit inputs

Secrets live only in `.env` / host environment variables. See `.env.example`.
