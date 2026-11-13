# zkVerify Agent Games 2026 agent

Our entry for [zkVerify Agent Games](https://agentgames.zkverify.io), starting with **Proof Gatekeeper**.

- `docs/research.md`: everything known about the competition (rules, schemas, scoring, circuit findings, open questions)
- `docs/raw-pages/`: text snapshots of the official site
- `circuits/`: official Groth16 circuit artifacts (wasm, zkey, exported verification keys, SHA256SUMS)
- `scripts/zk-probe/`: local scripts used to reverse-engineer the circuit inputs

Secrets live only in `.env` / host environment variables. See `.env.example`.
