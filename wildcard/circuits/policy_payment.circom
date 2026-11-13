pragma circom 2.1.9;

// Policy Vault payment circuit.
//
// Proves: "this payment (recipient, amount, deadline) is allowed by the policy whose
// Poseidon commitment the vault stores", without revealing the policy.
//
// Policy (private): maxPerTx, policyExpiry, the allowlist of recipients (as a Merkle root),
// and a salt so the commitment can't be brute-forced from a guessed policy.
//
// Public inputs, in this order (the vault rebuilds exactly this list on chain):
//   policyCommitment, recipient, amount, nonce, validUntil, vault, chainId

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// Root of a Poseidon Merkle tree from a leaf and its path.
// pathIndices[i] = 0 when the current node is the left child, 1 when it is the right child.
template MerkleRoot(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal cur[depth + 1];
    signal left[depth];
    signal right[depth];
    component h[depth];

    cur[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        left[i] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== left[i];
        h[i].inputs[1] <== right[i];
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}

template PolicyPayment(depth) {
    // Public
    signal input policyCommitment;
    signal input recipient;
    signal input amount;
    signal input nonce;
    signal input validUntil;
    signal input vault;
    signal input chainId;

    // Private: the policy
    signal input maxPerTx;
    signal input policyExpiry;
    signal input salt;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // Range checks, so no value can wrap around the field.
    component recipientBits = Num2Bits(160);
    recipientBits.in <== recipient;
    component amountBits = Num2Bits(128);
    amountBits.in <== amount;
    component maxBits = Num2Bits(128);
    maxBits.in <== maxPerTx;
    component untilBits = Num2Bits(64);
    untilBits.in <== validUntil;
    component expiryBits = Num2Bits(64);
    expiryBits.in <== policyExpiry;

    // 0 < amount <= maxPerTx
    component amountZero = IsZero();
    amountZero.in <== amount;
    amountZero.out === 0;
    component underMax = LessEqThan(128);
    underMax.in[0] <== amount;
    underMax.in[1] <== maxPerTx;
    underMax.out === 1;

    // The payment's deadline is inside the policy's lifetime.
    component inLifetime = LessEqThan(64);
    inLifetime.in[0] <== validUntil;
    inLifetime.in[1] <== policyExpiry;
    inLifetime.out === 1;

    // The recipient is on the allowlist.
    component leaf = Poseidon(1);
    leaf.inputs[0] <== recipient;
    component tree = MerkleRoot(depth);
    tree.leaf <== leaf.out;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // The policy is the committed one.
    component commit = Poseidon(4);
    commit.inputs[0] <== maxPerTx;
    commit.inputs[1] <== policyExpiry;
    commit.inputs[2] <== tree.root;
    commit.inputs[3] <== salt;
    commit.out === policyCommitment;

    // nonce, vault and chainId only bind the proof to one payment on one vault.
    // Groth16 binds every public input already; these squares keep them in the R1CS explicitly.
    signal nonceSq <== nonce * nonce;
    signal vaultSq <== vault * vault;
    signal chainSq <== chainId * chainId;
}

// Depth 8: up to 256 allowlisted recipients.
component main {public [policyCommitment, recipient, amount, nonce, validUntil, vault, chainId]} = PolicyPayment(8);
