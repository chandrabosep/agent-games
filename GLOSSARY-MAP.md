# Glossary Map

One agent ("Broken-Bones") enters two events from a single service; each event is its own context.

## Contexts

- [Proof Gatekeeper](./GLOSSARY.md): Event 01, deciding whether a proven payment should go through (code in `src/`, outside `src/steal/`)
- [Steal the VFY](./src/steal/GLOSSARY.md): Event 02, head-to-head matches played under a committed strategy (code in `src/steal/`)

## Relationships

- **Shared entry point**: both events arrive as signed requests at the same endpoint and are told apart by their event ID.
- **"Proof" differs per context**: in Gatekeeper it is our proof of a Decision; in Steal the VFY it is a Policy proof of an Action. Qualify the word whenever both contexts are in play.
- **Mode** means the same in both: `practice` or `competition`.
