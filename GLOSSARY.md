# Proof Gatekeeper

Our agent for zkVerify Agent Games Event 01. It acts as a payment approver: each task carries a proof that verifies, and the agent decides whether the payment it describes should go through.

## Tasks and decisions

**Task**:
One signed request from the platform asking for a decision on a single payment, identified by its `task_id`.
_Avoid_: Job, request, challenge

**Retry**:
A repeat delivery of a Task with a `task_id` already answered; it gets the original response back, unchanged.
_Avoid_: Duplicate, replay

**Mode**:
Whether a Task is `practice` (unscored, dashboard-triggered) or `competition` (scored round).

**Decision**:
The agent's verdict on a Task: APPROVE or REJECT. Determined only by the Checks, never by whether a Proof was produced.
_Avoid_: Verdict, outcome, answer

**Check**:
One rule a Task must pass to be approved. Checks run in a fixed order; the first one that fails names the Trap.

**Trap**:
A Task built to look approvable while failing exactly one or more Checks. Six kinds: reused proof, VK substitution, threshold mismatch, expired condition, recipient mismatch, amount overflow.
_Avoid_: Attack, bad task

**Reason code**:
The single label sent with a Decision: the first failing Check's Trap, or `VALID_CONDITION` on APPROVE.

## Proofs

**Proof**:
The Groth16 proof our agent generates with the gatekeeper circuit, attesting that its Decision matches the rules for that Task's inputs.
_Avoid_: ZK proof (ambiguous with the Task's own proof), attestation

**Provable task**:
Any Task except one rejected as a reused proof; a Proof is expected for it, and a missing or invalid one costs points.

**Proof reference**:
The `proof_tx` value carried in a Task's input, identifying the payment proof the Task is about.
_Avoid_: Proof (that's ours), tx hash

**Seen-set**:
The Proof references our agent has approved in a given Mode. A Task whose Proof reference is already in it is a reused-proof Trap.
_Avoid_: Replay cache, blacklist

**Explanation**:
A plain-language account of a Decision, written by a language model after the response is sent. It never influences the Decision.
_Avoid_: Reasoning, rationale (the Decision has none beyond the Checks)

**Dispute evidence**:
Our Proof submitted to zkVerify through Kurier after the response is sent, kept so a score can be contested.
