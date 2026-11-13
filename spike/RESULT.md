# Spike result: zkVerify aggregation latency (PROTOTYPE, throwaway)

**Question:** Can a smart contract on an L2 check a Groth16 proof through zkVerify fast enough to gate an agent's transactions?

**Answer: yes, about 2.7 minutes end to end** (one sample, testnet, 13 Nov 2026).

| Step | Time after submit |
|---|---|
| Kurier `submit-proof` (`optimisticVerify: success`) | 0 s |
| Submitted | 0.2 s |
| IncludedInBlock (zkVerify testnet) | 5.8 s |
| AggregationPending | 22.1 s |
| Aggregated, and the receipt is live on Base Sepolia | **161.5 s** (Base Sepolia block 58311661, 15:36:41 UTC, tx `0x37830b30…1a58`) |

- Proof job `a580d3ba-df77-11f1-bb46-22f5290c9c2d`, aggregationId 64987, **domainId 2** (Base Sepolia). Kurier doesn't return the domain; we found it by calling the contract.
- `verifyProofAggregation(2, 64987, leaf, [], 1, 0)` on proxy `0x0807C544D38aE7729f8798388d89Be6502A1e8A8` returns **true**. A garbage leaf or the wrong aggregationId returns false.
- Kurier's `Aggregated` status already means the receipt is on the destination chain. `AggregationPublished` never appeared in 12 minutes, so don't wait for it.
- Our proof was the only leaf in its aggregation (`numberOfLeaves: 1`, empty Merkle path). The domain publishes on a timer, not when a batch fills up.
- Registering the VK on testnet took 23 s. The hash `0x6b79…77b0` matches the official mainnet vkHash, so the hash depends only on the VK.
- Base Sepolia makes a block every 0.2 s, so a search by block number needs a wide window.

**Leaf recomputed from our own public inputs (off-chain): matches Kurier's leaf.**
`leaf = keccak256(keccak256("groth16") ‖ vkHash ‖ sha256("") ‖ keccak256(LE32(sig_0) ‖ … ‖ LE32(sig_12)))`. Each public signal is a 32-byte word with its bytes reversed, which is the docs' `_changeEndianess`. Big-endian doesn't match. So a contract can derive the leaf from values it knows, such as the transaction hash, and needs nothing from us.

**Not yet tested:**
- Running that same leaf computation in Solidity (the off-chain version matches; the on-chain version hasn't been written).
- Mainnet latency, and latency under load.
- Gas cost.

Scripts: `spike/zkv-aggregation-timing.mjs` (submit and time) and `spike/zkv-onchain-check.mjs` (ask the contract).
