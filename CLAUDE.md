# Proof Gatekeeper agent (zkVerify Agent Games 2026)

Our live entry for Event 01. Domain words (Task, Decision, Check, Trap, Proof reference, Seen-set, Explanation) are defined in `GLOSSARY.md`; use them. Steal the VFY (Event 02) has its own context in `src/steal/GLOSSARY.md`; `GLOSSARY-MAP.md` lists both.

## Where to look

- **Testing, deploying, or picking up where the last session stopped** → `docs/testing.md` (current status, open checks, procedures).
- **Competition rules, schemas, scoring, circuit findings** → `docs/research.md`; raw site text in `docs/raw-pages/`.
- **Module layout and commands** → `README.md`, `package.json`.

## Rules that decide behaviour

- Deterministic code makes every Decision. A language model only writes the Explanation, after the response is sent. The organizers require this, and the circuit enforces it.
- The Decision never depends on whether a Proof was produced. A missing Proof costs 2; a wrong REJECT costs 3.
- Only *approved* Proof references go in the Seen-set (per Mode). The site defines reuse as "already accepted in a previous task".
- Reason-code strings live only in `src/reasonCodes.ts`.

## Operations

- Live: `https://proof-gatekeeper.onrender.com/agent`, Render service `srv-dbradhoae00c73f34l80` (Starter plan, 1 GB disk at `/var/data`, auto-deploy off). The Render CLI is logged in; read logs with `render logs -r srv-dbradhoae00c73f34l80 --limit 100 -o text`.
- **Deploy window:** Gatekeeper rounds run 16:00–02:00 IST daily, 13–20 Nov (schedule changed on 13 Nov; recheck the event page). Steal the VFY matches have no published times; never deploy mid-match. Each deploy takes the agent offline for 10–70 s (disk), so deploy only outside those windows. Confirm with the user before every deploy.
- Secrets live in `.env` (gitignored) and Render env vars: `AGENT_GAMES_HMAC_SECRET`, `ANTHROPIC_API_KEY`. Collect new secrets with the secure prompt (`request_secret`), never in chat, and redact them in any output.
- **Lockfile gotcha:** Render builds with npm 10, which rejects versionless lockfile entries that npm 11 writes on `npm i`. `test/lockfile.test.ts` catches it; strip the entry before pushing.
- The repo is public (judges review it). Commit only what is safe to publish.
