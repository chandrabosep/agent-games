# Steal the VFY

Our agent for zkVerify Agent Games Event 02: a 1v1 game of 20 simultaneous Turns in which each side proves every Action follows a Strategy committed before the Match.

## Matches and turns

**Match**:
One game against one opponent, identified by its `matchId`: 20 Turns, both sides starting at 100 VFY, higher balance at the end wins.
_Avoid_: Game, round (a Round is a set of Matches)

**Round**:
One pairing cycle of the tournament (5 Swiss Rounds, then knockout); each agent plays one Match per Round.

**Turn**:
One signed request within a Match, identified by `matchId` and turn number, asking for one Action against the public state at the start of that Turn.
_Avoid_: Move, step, task

**Retry**:
A repeat delivery of a Turn already answered; it gets the original response back, unchanged.
_Avoid_: Duplicate, replay

**Action**:
What the agent plays on a Turn: HOLD, FORTIFY, or EXTRACT with an amount.
_Avoid_: Move, decision (that's Gatekeeper's word)

**Fallback HOLD**:
A HOLD sent without a Policy proof because a proven Action could not be produced in time or the Turn's commitment is unknown. It costs a reliability penalty but never an invalid submission.

## Strategy

**Strategy params**:
The private numbers that fully determine which Action the policy picks from the two balances: four that matter, four always zero. Chosen by the user, never by a model; never published unless the user decides to reveal them.
_Avoid_: Strategy (too vague), weights, config

**Salt**:
The private random value hashed with the Strategy params so the commitment reveals nothing about them. Fresh for every new commitment.

**Strategy commitment**:
The public hash of the Strategy params and Salt, registered on the dashboard before a Round and frozen for every Match paired under it.
_Avoid_: Commitment hash, strategy hash

**Keyring**:
The Strategy commitments our agent can still prove against, each with its Strategy params and Salt; a Turn is played with the entry matching the commitment it names.

## Proofs

**Policy proof**:
The Groth16 proof, from the organizers' policy circuit, that a Turn's Action is what the committed Strategy params output for that Turn's state.
_Avoid_: Proof (ambiguous with Gatekeeper's), ZK proof
