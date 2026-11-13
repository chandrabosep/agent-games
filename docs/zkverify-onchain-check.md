# zkVerify on-chain check: verifier interface, leaf, gas, mainnet

Compiled 13 Nov 2026 for the Event 03 Wildcard scoping. It builds on `spike/RESULT.md`. Everything
here comes from zkVerify's own repos and docs, Kurier's own OpenAPI spec, verified contract source on
Sourcify and Blockscout, and read-only RPC calls (`eth_call`, `eth_estimateGas`, `eth_getStorageAt`,
`eth_getLogs`, plus a Foundry fork test that sends nothing). No transactions were sent and no keys were used.

Source versions used for citations:
- Contracts: `zkVerify/zkv-attestation-contracts` at `2e0c9f16835775f7b5b4ed0a1e644473842836c2` (HEAD of `main`, 11 Apr 2025). Below it is shortened to **C** = `https://github.com/zkVerify/zkv-attestation-contracts/blob/2e0c9f16835775f7b5b4ed0a1e644473842836c2/`.
- Node: `zkVerify/zkVerify` at tag `v2.1.0-20261106` (`2959b6f56ce2703199c25b405942068f332168c9`), shortened to **N** = `https://github.com/zkVerify/zkVerify/blob/2959b6f56ce2703199c25b405942068f332168c9/`. `compute_statement_hash` is byte-for-byte identical at tag `v2.0.0-20260807`. Live mainnet runtime reports `zkv-runtime` specVersion 2000000, and Volta testnet reports `tzkv-runtime` 2001000.
- Docs: live https://docs.zkverify.io, cross-checked against `zkVerify/zkverify-docs` at `35d4bea72f8116bea9ebd50a97d9772d4c9e83ad`.

---

## TL;DR

| # | Question | Answer |
|---|---|---|
| 1 | Verifier interface | One function: `verifyProofAggregation(uint256 _domainId, uint256 _aggregationId, bytes32 _leaf, bytes32[] _merklePath, uint256 _leafCount, uint256 _index) view returns (bool)`. It takes the **raw statement hash** as `_leaf` and hashes it once more itself. `[]`, `1`, `0` are the Merkle path, the number of leaves, and the 0-based leaf index. The contract emits `AggregationPosted(domainId, aggregationId, root)` when a root is stored. Both proxies are **UUPS (ERC-1967) and upgradeable**: Base Sepolia uses implementation `0x312468Eb…0FC0` (`ZkVerifyAggregationGlobal`) and Base mainnet uses `0x5596aE76…a1C6` (`ZkVerifyAggregation`). An **EOA** holds `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE` on each, and another EOA holds `OPERATOR`. |
| 2 | Leaf in Solidity | Use the official `ZkVerifyGroth16.statementHash()` from the contracts repo. **We ran it in a fork test on our 13 signals and it reproduced Kurier's leaf exactly.** `sha256("")` is the pallet's `NO_VERSION_HASH`, the default `verifier_version_hash()`. Groth16 doesn't override it, so it's constant for Groth16. Versioned verifiers (risc0, ultrahonk, …) use a real version hash. **Don't copy the docs' `_changeEndianess`**: its right-shifts are wrong (1/2/3/4 instead of 8/16/32/64). |
| 3 | Gas | Not documented anywhere. Measured: contract-to-contract `verifyProofAggregation`, cold, costs **~13.7k gas with an empty path, +~1.65k per path element** (~23.7k for a 6-deep path, the maximum for mainnet domain 2). Leaf for 13 signals is **~12k**. `ZkVerifyGroth16.verify` end to end (leaf + cold call, empty path) is **~25.5k**. A top-level tx calling only the proxy estimates to 32.2k (empty path) and 48.2k (7-deep path). |
| 4 | Mainnet | Base mainnet proxy is `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69`, **domainId 2** (same id as Base Sepolia). Bytecode is present, the implementation is verified, and a read call works. Mainnet domain 2 has **aggregation size 64** (testnet: 8), anyone may submit proofs to it, and it published roughly every 2–2.5 min today (testnet: every 2.5–8 min). Kurier mainnet charges $0.005 per `submit-proof` (x402, USDC on Base). |
| 5 | Blockers | None hard. Roots are **never pruned** (aggregation 1 of domain 2 is still stored on Base mainnet). Anyone can call the verifier (it's `view`, no access control). Trust caveats: the operator can overwrite any stored root, and the admin EOA can upgrade the contract. The verifier itself has **no replay protection**, so a valid tuple verifies forever. Kurier's `Aggregated` status can arrive a few seconds **before** the root lands on Base, so check with `eth_call` first. zkVerify documents no reorg/finality policy for the relayer. |

---

## 1. The on-chain verifier interface

### 1.1 Signature and what each argument means

The interface published in the contracts repo and quoted in the docs is ([C]`contracts/interfaces/IVerifyProofAggregation.sol`, https://docs.zkverify.io/overview/getting-started/smart-contract):

```solidity
function verifyProofAggregation(
    uint256 _domainId,
    uint256 _aggregationId,
    bytes32 _leaf,
    bytes32[] calldata _merklePath,
    uint256 _leafCount,
    uint256 _index
) external view returns (bool);
```

The implementation sits in the shared base contract ([C]`contracts/abstract/ZkVerifyAggregationBase.sol#L32-L45`):

```solidity
bytes32 proofsAggregation = proofsAggregations[_domainId][_aggregationId];
return Merkle.verifyProofKeccak(proofsAggregation, _merklePath, _leafCount, _index, _leaf);
```

The NatSpec in the same file defines the last three arguments: `_merklePath` "path from leaf to root of the merkle tree", `_leafCount` "the number of leaves in the merkle tree", and `_index` "the 0 indexed `index`'th leaf from the bottom left of the tree". So our call `(2, 64987, leaf, [], 1, 0)` means a one-leaf tree, so no siblings, and our leaf is leaf 0. These map one to one onto Kurier's `aggregationDetails.merkleProof`, `numberOfLeaves` and `leafIndex` (Kurier OpenAPI spec, `GET /api/v1/job-status/{apiKey}/{jobId}`, https://api.kurier.xyz/docs/json, v1.36.0).

**There is only one variant. It takes the raw leaf (the statement hash); there is no variant that computes the statement for you.** `Merkle.verifyProofKeccak` hashes the leaf once more before walking the path ([C]`contracts/lib/Merkle.sol#L27`): `computedHash = keccak256(abi.encodePacked(leaf))`. That matches the pallet, which builds the root with Substrate's `binary_merkle_tree::merkle_root::<Keccak256, _>` over the statements ([N]`pallets/aggregate/src/data.rs#L141-L145`). Our spike data confirms it: with one leaf, `keccak256(0x95b0…7138) = 0x9b69…18d3`, which is exactly Kurier's `root`/`receipt` and the value stored on Base Sepolia. So pass Kurier's `leaf` (= `statement`), **not** its `root`.

Other behaviour, from the same `Merkle.sol`:
- `_index >= _leafCount` reverts with `IndexOutOfBounds()` (selector `0x4e23d035`). We confirmed this on Base Sepolia: `(2, 64987, leaf, [], 1, 1)` reverts with that selector.
- An unknown `(domainId, aggregationId)` reads `bytes32(0)` and returns `false`; it doesn't revert. The docs say it "Checks `_aggregationId` exists" (https://docs.zkverify.io/architecture/proof-verification-smart-contract), but the code has no explicit existence check. The zero root simply never matches.
- The path walk handles Substrate's unbalanced tree via `position % 2 == 1 || position + 1 == width` ([C]`contracts/lib/Merkle.sol#L36-L40`). The docs explain why it isn't OpenZeppelin's sorted-pair verifier (https://docs.zkverify.io/architecture/proof-verification-smart-contract).

### 1.2 Write path and events

The contract stores roots in `mapping(uint256 => mapping(uint256 => bytes32)) public proofsAggregations` and emits
`event AggregationPosted(uint256 indexed _domainId, uint256 indexed _aggregationId, bytes32 indexed _proofsAggregation)` from `_registerAggregation` ([C]`contracts/abstract/ZkVerifyAggregationBase.sol#L10-L16`, `#L47-L55`). Roots arrive through:
- `submitAggregation(domainId, aggregationId, root)` and `submitAggregationBatchByDomainId(domainId, ids[], roots[])`, both `onlyRole(OPERATOR)` ([C]`contracts/ZkVerifyAggregation.sol#L61-L90`).
- On testnet's `ZkVerifyAggregationGlobal`, also Hyperbridge `onAccept()` (`onlyHost`, source state machine `SUBSTRATE-zkv_`) ([C]`contracts/ZkVerifyAggregationGlobal.sol`).

On chain, every recent Base Sepolia and Base mainnet publish was a `submitAggregationBatchByDomainId` call (selector `0xf3aff075`) using 55,350 gas (Sepolia) or 55,406 gas (mainnet) per single-aggregation batch. Sepolia txs were read via https://base-sepolia.blockscout.com/api/v2/addresses/0x0807C544D38aE7729f8798388d89Be6502A1e8A8/logs, and mainnet txs via `eth_getLogs` and `eth_getTransactionReceipt` on a public Base RPC (e.g. tx `0x6d472e7a8fb167000a3403cb0d86767d0b74bac1535eb175378d1cd39941b50d`, aggregation 148716). A consumer can index `AggregationPosted` filtered on `topic1 = domainId` and `topic2 = aggregationId` to know when its root has landed.

### 1.3 Proxy, implementation, and who controls it

Both proxies are `ZkVerifyAggregationProxy`, a plain `ERC1967Proxy` ([C]`contracts/proxy/ZkVerifyAggregationProxy.sol`). The implementations are UUPS: `_authorizeUpgrade` is `onlyRole(UPGRADER_ROLE)` ([C]`contracts/ZkVerifyAggregation.sol#L98`), and the initializer grants `DEFAULT_ADMIN_ROLE` to the deployer, `OPERATOR` to `_operator`, and `UPGRADER_ROLE` to `_upgrader` (`#L36-L52`). The EIP-1967 admin slot is empty on both, as expected for UUPS.

| | Base Sepolia | Base mainnet |
|---|---|---|
| Proxy | `0x0807C544D38aE7729f8798388d89Be6502A1e8A8` | `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69` |
| Implementation (EIP-1967 slot, read 13 Nov) | `0x312468EbF274F1f584d93d0CCA8458cC91460FC0` | `0x5596aE76a636483361C9e777C03091BAEDcEa1C6` |
| Implementation contract | `ZkVerifyAggregationGlobal` (bot + Hyperbridge), verified on Blockscout: https://base-sepolia.blockscout.com/address/0x312468EbF274F1f584d93d0CCA8458cC91460FC0 | `ZkVerifyAggregation` (bot only), Sourcify exact match: https://sourcify.dev/server/v2/contract/8453/0x5596ae76a636483361c9e777c03091baedcea1c6 |
| Proxy deploy tx | `0x36bc4e9e…0859` (block 23535092) | `0x4b02206a…8312` (block 35713469) |
| `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE` | `0x4F4C0F1E64e17516dd7cf95576658A270a681D3f` (EOA) | `0xA4c835eB478f391a0bB2e0E50B0014c6BfBa2E1B` (EOA) |
| `OPERATOR` (current, `hasRole` = true) | `0x162845DAE4317fFBBD9D5Db3A2d7D7A895FE4F8E` (EOA) | `0x93A0d40e9f1Cb8956861F555c36313281F9D9783` (EOA, sender of every recent publish) |

The verified sources' `contracts/` files are **identical** to the repo at `2e0c9f1` for `ZkVerifyAggregation.sol`, `ZkVerifyAggregationBase.sol`, `Merkle.sol`, `ZkVerifyAggregationGlobal.sol` and `IVerifyProofAggregation.sol`, so the verify logic is the same on testnet and mainnet. (The Sepolia Blockscout bundle also carries an **older** `ZkVerifyGroth16.sol` without the version hash. It isn't used by the aggregation contract, but don't copy the Groth16 helper from there.)

On Base Sepolia the full role history is visible: the original operator was revoked, and `0x1628…4F8E` got admin at block 39941938, then lost it at 39942005, and got `OPERATOR` at 39942038 (Blockscout `getLogs` for `RoleGranted`/`RoleRevoked`). Only one `Upgraded` event exists (at deploy). On mainnet I could read the deploy-tx roles and current `hasRole` values, but not the full event history (public RPCs cap `eth_getLogs` at 10k blocks). The implementation slot today equals the one set at deploy.

The same mainnet proxy address `0xCb47…2b69` also holds bytecode on Arbitrum One and OP Mainnet, and points to the same implementation `0x5596…a1C6` there.

---

## 2. Computing the leaf in Solidity

### 2.1 The official snippet

The contracts repo ships a ready Groth16 helper whose README says "A smart contract that needs to perform proof verification should inherit from the relevant smart contract inside `contracts/verifiers`" ([C]`README.md`). From [C]`contracts/verifiers/ZkVerifyGroth16.sol` (last changed in `0a2dd75`, "Update statement hash with non-optional version hash", 7 Mar 2025):

```solidity
bytes32 constant PROVING_SYSTEM_ID = keccak256(abi.encodePacked("groth16"));
bytes32 constant NO_VERSION_HASH = sha256(abi.encodePacked(""));

function statementHash(bytes32 vkHash, uint256[] memory inputs) public pure returns (bytes32) {
    return keccak256(
        abi.encodePacked(PROVING_SYSTEM_ID, vkHash, NO_VERSION_HASH, keccak256(encodePublicInputs(inputs)))
    );
}

function encodePublicInputs(uint256[] memory inputs) public pure returns (bytes memory) {
    uint256 numInputs = inputs.length;
    bytes32[] memory encodedInputs = new bytes32[](numInputs);
    for (uint256 i = 0; i != numInputs; i++) {
        encodedInputs[i] = _changeEndianess(inputs[i]);
    }
    return abi.encodePacked(encodedInputs);
}

function _changeEndianess(uint256 input) internal pure returns (bytes32 out) {
    out = bytes32(input);
    // swap bytes
    out = ((out & 0xff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00) >> 8)
        | ((out & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff) << 8);
    // swap 2-byte long pairs
    out = ((out & 0xffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000) >> 16)
        | ((out & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff) << 16);
    // swap 4-byte long pairs
    out = ((out & 0xffffffff00000000ffffffff00000000ffffffff00000000ffffffff00000000) >> 32)
        | ((out & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff) << 32);
    // swap 8-byte long pairs
    out = ((out & 0xffffffffffffffff0000000000000000ffffffffffffffff0000000000000000) >> 64)
        | ((out & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff) << 64);
    // swap 16-byte long pairs
    out = (out >> 128) | (out << 128);
}
```

The same file also has `verify(vkHash, inputs, domainId, aggregationId, merklePath, leafCount, index)`, which computes the leaf and calls the proxy. The license header is `UNLICENSED` (the rest of the repo is Apache-2.0), so copying the pattern is safer than copying the file verbatim.

**Checked:** in a Foundry fork of Base Sepolia (block 58311700), `statementHash(0x6b79…77b0, <our 13 signals>)` returned `0x95b00e606273fac7d20936d073ed3a257d3c04b6ab4aa1433cbbd1d077387138`, which equals Kurier's `leaf`. `verify(…, 2, 64987, [], 1, 0)` returned `true`. That closes the spike's open item "running that same leaf computation in Solidity".

**Docs bug, don't copy:** the docs tutorial's Circom `_changeEndianess` (https://docs.zkverify.io/overview/getting-started/smart-contract; source `docs/overview/02-getting-started/08-smart-contract.md#L189-L225` in the docs repo) shifts right by `1`, `2`, `3`, `4` where it should shift by `8`, `16`, `32`, `64`. The left shifts are correct. It produces a wrong leaf for any input with more than one non-zero byte. The live page has the same text as of 13 Nov. The older Foundry example `zkVerify/zkverify-evm-dapp-example` (`contracts/src/ZkFactorization.sol` at `c6c7f3d`) has the correct shifts, but it calls the retired `verifyProofAttestation(...)` and omits the version hash, so it's outdated too.

The docs tutorial's leaf line also hashes **one** public input (`keccak256(abi.encodePacked(_changeEndianess(_hash)))`). For several inputs, the byte string is the concatenation of every reversed 32-byte word, which is what `encodePublicInputs` does.

### 2.2 Where the statement hash is defined in the node

- Generic formula: `pallet_verifiers::compute_statement_hash` ([N]`pallets/verifiers/src/lib.rs#L213-L232`):
  ```rust
  let mut data_to_hash = keccak_256(ctx).to_vec();          // ctx = I::hash_context_data()
  data_to_hash.extend_from_slice(vk_hash.as_bytes());       // registered vkHash, or I::vk_hash(vk)
  data_to_hash.extend_from_slice(version_hash.as_bytes());  // I::verifier_version_hash(proof)
  data_to_hash.extend_from_slice(keccak_256(pubs.as_bytes_ref()).as_bytes_ref()); // I::pubs_bytes(pubs)
  H256(keccak_256(data_to_hash.as_slice()))
  ```
- Groth16 pieces ([N]`verifiers/groth16/src/lib.rs`): `hash_context_data()` returns `b"groth16"` (L51-L53). `pubs_bytes()` is "the concatenated scalars bytes" of `Vec<Scalar>` (L81-L87). `MAX_NUM_INPUTS = 64` (L32). `verify_proof` rejects any scalar whose length isn't the curve's scalar size (32 bytes), because `pubs_bytes` hashes the raw bytes.
- Byte order: the Groth16 pallet doc says "`Scalars` are little-endian encoded" (https://docs.zkverify.io/architecture/verification_pallets/groth16, docs repo `docs/architecture/07-verification_pallets/04-groth16.md#L82`). So `_changeEndianess` turns an EVM big-endian `uint256` into the bytes the pallet hashed.
- vkHash: the default `vk_hash` is `keccak_256(vk.encode())`, i.e. keccak of the SCALE-encoded VK ([N]`pallets/verifiers/traits/src/lib.rs#L103-L111`). That's why the hash depends only on the VK, as the spike observed.

### 2.3 What `sha256("")` is

It's the **verifier version hash**. The trait declares `fn verifier_version_hash(_proof) -> H256 { NO_VERSION_HASH }` with the comment "Return a hash that represents the verifier version used to verify the proof" ([N]`pallets/verifiers/traits/src/lib.rs#L118-L122`). The default is defined as ([N]`pallets/verifiers/traits/src/lib.rs#L33-L36`):

```rust
pub const NO_VERSION_HASH: H256 = H256(hex!(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" // = SHA256("")
));
```

Groth16 does not override it, so for Groth16 it's constant. It doesn't depend on the curve or the snarkjs version. Verifiers with versioned provers override it per proof version. risc0, for example, returns a different constant for `V1_0`, `V1_1`, `V1_2`, `V2_0`, … ([N]`verifiers/risc0/src/lib.rs#L224`). The docs tutorial lists `sha256("")` for Circom, Ultraplonk and SP1, `sha256("risc0:v1.1")` for risc0, and `sha256("ultrahonk:v3.0")` for UltraHonk. It also warns: "We are constantly releasing new provers' versions … You might want to make your contract upgradeable or envision having permissioned setters to modify the VERSION_HASH later" (https://docs.zkverify.io/overview/getting-started/smart-contract). For a Groth16-only design, hard-coding `sha256("")` matches the current pallet. A setter is cheap insurance if zkVerify ever versions Groth16.

The term became mandatory in the contracts repo on 7 Mar 2025 (`0a2dd75`). Earlier helpers hashed only three parts. A minor docs inconsistency: the Groth16 pallet page lists only three "Statement hash components" (context, vk, pubs) (https://docs.zkverify.io/architecture/verification_pallets/groth16), while the proof-submission page gives the four-part formula with `version_hash(proof)` (https://docs.zkverify.io/architecture/proof-submission-interface). The code and our on-chain check agree with the four-part version.

---

## 3. Gas cost

No zkVerify doc gives a gas figure for `verifyProofAggregation` or the leaf. The only gas statements are qualitative: the batch publish "saves gas" (https://docs.zkverify.io/architecture/proof-verification-smart-contract), and larger aggregations mean "a bigger cost" for the membership proof (https://docs.zkverify.io/architecture/proof-aggregation/domain-management). So I measured it. Everything below is read-only.

**A. Top-level `eth_estimateGas` against the proxy** (Base Sepolia `https://sepolia.base.org`; this includes the 21k intrinsic cost and calldata):

| Path length (leafCount) | 0 (1) | 1 (2) | 2 (4) | 3 (8) | 4 (16) | 5 (32) | 6 (64) | 7 (128) |
|---|---|---|---|---|---|---|---|---|
| gas | 32,208 | 34,499 | 36,779 | 39,058 | 41,338 | 43,617 | 45,898 | 48,178 |

Base mainnet, empty path: 32,164. Result true or false makes no difference to the gas.

**B. Contract-to-contract, measured with `gasleft()` in a Foundry fork of Base Sepolia** (solc 0.8.20, optimizer 200 runs for our side). This is the number that matters when our gate contract makes the call:

| What | gas |
|---|---|
| `verifyProofAggregation`, everything cold, empty path | ~13.7k |
| … path 3 / 6 / 7 | ~18.7k / ~23.7k / ~25.3k (**~1.65k per path element**) |
| … same tuple again in the same tx (warm) | ~3.7k |
| `statementHash(vkHash, 13 inputs)` (byte swap ×13 + 2 keccaks + `sha256` constant) | ~12.2k (measured as an external call; inlined it will be a bit less) |
| `ZkVerifyGroth16.verify(...)` end to end, cold, empty path (leaf + proxy call) | ~25.5k |

The cold cost is mostly EIP-2929 access: the cold proxy account, the cold implementation via `delegatecall`, and one cold `SLOAD` of the root. For mainnet domain 2 (aggregation size 64, §4), expect up to a 6-element path, so roughly **~36k gas for the full check from inside a contract**, before our own logic. To reproduce: `cast estimate <proxy> 'verifyProofAggregation(uint256,uint256,bytes32,bytes32[],uint256,uint256)(bool)' 2 64987 <leaf> '[]' 1 0 --rpc-url https://sepolia.base.org`. A path with dummy siblings costs the same gas as a real one, because the loop doesn't depend on the result.

---

## 4. Mainnet deployment

From https://docs.zkverify.io/architecture/contract-addresses (live page matches docs repo `docs/architecture/08-contract-addresses.md`) and https://docs.zkverify.io/architecture/proof-aggregation/domain-management (System Domains table):

| Network | Chain ID | Proxy | Domain ID |
|---|---|---|---|
| **Base** | 8453 | `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69` | **2** |
| Arbitrum One | 42161 | `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69` | 10 |
| OP Mainnet | 10 | `0xcb47a3c3b9eb2e549a3f2ea4729de28cafbb2b69` | 9 |
| Horizen | 26514 | `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69` | 3 |
| Robinhood Chain | 4663 | `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69` | 11 |
| Apechain | 33139 | `0x1a6fe16501ab68adb8d3bb24c299e79cbf190d39` | 8 |
| *Base Sepolia (testnet)* | 84532 | `0x0807C544D38aE7729f8798388d89Be6502A1e8A8` | 2 |

All system domains use the "Bot" mechanism: zkVerify's Aggregator Service calls `aggregate`, and an off-chain relayer publishes the receipt (same page). The docs do publish the domain id, so the spike's domain probe wasn't strictly needed, though it did confirm the docs.

**Confirmed on chain (13 Nov):**
- Base mainnet proxy has bytecode, its EIP-1967 implementation is `0x5596…a1C6` (Sourcify exact match, `ZkVerifyAggregation`), and `verifyProofAggregation(2, 999999999, leaf, [], 1, 0)` returns `false`. The read path works.
- Domain 2 on Base mainnet is live: 59 `AggregationPosted` events (all domain 2) in the last ~40,000 blocks. Latest seen: aggregation 148716 at block 56979411 (16:10:57 UTC), with gaps of about 2.3–2.5 min. On Base Sepolia, domain 2 published aggregations 64986–64993 between 15:30 and 16:03 UTC, 2.5–8 min apart.
- Arbitrum One and OP Mainnet: the proxy has bytecode and points to the same implementation.

**Domain config read from the zkVerify chains** (`aggregate.domains(2)` via `wss://zkverify-rpc.zkverify.io` and `wss://zkverify-volta-rpc.zkverify.io`, the RPC URLs from https://docs.zkverify.io/overview/getting-started/connect-a-wallet):

| | Mainnet domain 2 | Testnet (Volta) domain 2 |
|---|---|---|
| `maxAggregationSize` | **64** → Merkle path ≤ 6 | 8 → path ≤ 3 |
| `publishQueueSize` | 16 | 16 |
| `proofRules` (who may submit proofs) | `Untrusted` (anyone) | `Untrusted` |
| `aggregateRules` (who may publish) | `OnlyOwnerUncompleted`: anyone may publish a full aggregation, only owner/manager an incomplete one | same |
| `delivery.destination` | `None` (the bot relayer delivers, not Hyperbridge) | `None` |
| pending aggregation at read time | id 148717, 26 of 64 statements | id 64995, 0 of 8 |

Rule meanings are from https://docs.zkverify.io/architecture/proof-aggregation/core-concepts. The pallet caps are `aggregationSize` 128 and `maxPendingPublishQueueSize` 16 (runtime constants). This matches the docs' "smaller than 128" and "smaller or equal than 16" (domain-management page).

**Differences that matter for us:**
- Mainnet aggregations are shared and bigger (26 statements pending when we looked), so expect a real 4–6-element path and a non-zero `leafIndex`. Testnet often gives a one-leaf tree, as in the spike. The contract must take path/count/index as calldata, not assume `[]`/1/0.
- The publish cadence seen today was faster on mainnet (~2.3 min) than on testnet. We haven't measured mainnet submit→root latency.
- Fees: Kurier mainnet `submit-proof` is $0.005 and `register-vk` is $0.001, paid via x402 in USDC on Base (`GET https://api.kurier.xyz/api/v1/pricing/`). Under the hood, submitters share the aggregation and delivery costs held by the pallet (https://docs.zkverify.io/architecture/proof-aggregation/core-concepts, "Users submitting proofs will equally split both costs").
- Testnet implementation is `ZkVerifyAggregationGlobal` (adds the Hyperbridge `onAccept`/`host()`); Base mainnet's is `ZkVerifyAggregation` (`host()` reverts). `verifyProofAggregation` is the same code in both.

---

## 5. Things that could block the design

- **Expiry/pruning on the EVM side: none.** No code deletes from `proofsAggregations` ([C]`contracts/abstract/ZkVerifyAggregationBase.sol`), and on Base mainnet `proofsAggregations(2, 1)` still returns a root (`0x7945…7fb8`). A receipt stays verifiable indefinitely. **The flip side: our contract must add its own replay protection** (e.g. mark each leaf, or a nullifier among the public signals, as used), because the same tuple returns `true` forever. Our Gatekeeper rule, "only approved Proof references go in the Seen-set", maps naturally onto a `used[leaf]` mapping.
- **Expiry on the zkVerify side (affects path retrieval, not verification).** The pallet keeps published aggregations only for the block they were published in: `Published::<T>::kill()` runs in every `on_initialize` ([N]`pallets/aggregate/src/lib.rs#L770-L777`, `#L832-L835`). `aggregate_statementPath` must therefore be queried at the `receiptBlockHash` (https://docs.zkverify.io/architecture/proof-aggregation/overview: "published aggregations have a limited lifetime"). Kurier returns the path and `receiptBlockHash` in `aggregationDetails`, so store them when the job reaches `Aggregated`.
- **No limit on stored aggregations** in the contract (two nested mappings). The zkVerify side caps pending aggregations per domain at the publish queue (16). When it's full, new proofs get `CannotAggregate(DomainFull)` (domain-management page).
- **Who may call the verifier: anyone.** It's `external view` with no modifier. Only writes are role-gated.
- **Trust assumptions (inherent to the bot mechanism, not blockers):** the `OPERATOR` EOA can write any root for any `(domainId, aggregationId)`, and `_registerAggregation` **overwrites** without checking. The admin/upgrader EOA can swap the implementation (§1.3). Our contract should pin the proxy address and `domainId`, and compute the leaf itself from `vkHash` and public inputs it trusts, never accepting a caller-supplied leaf.
- **Timing of Kurier statuses vs the destination chain.** Kurier docs describe `Aggregated` as "Proof successfully aggregated and published" and `AggregationPublished` as "Proof aggregation successfully published to zkVerify contract on destination chain" (https://docs.zkverify.io/overview/getting-started/kurier). Kurier's own status page lists only `Aggregated` (https://kurier.xyz/docs/job_statuses, "Version: Mainnet"). The OpenAPI spec has an `aggregationPublished {destinationChainId, destinationTxHash, createdAt}` object (https://api.kurier.xyz/docs/json). In the spike, Kurier's `updatedAt` for `Aggregated` was **15:36:38Z**, while the Base Sepolia block holding the root has timestamp **15:36:41Z**, so `Aggregated` came about 3 s before the root was on Base. The spike only saw the root because its poll happened to land at 161.5 s. The agent should check with `eth_call verifyProofAggregation` (or watch for `AggregationPosted`) before sending the gated transaction. (These two sources disagree on whether `AggregationPublished` exists; the spike never saw it in 12 min.)
- **Reorg/finality:** zkVerify uses BABE + GRANDPA with deterministic finality (https://docs.zkverify.io/architecture/mainchain/consensus). I found no zkVerify doc saying whether the relayer waits for GRANDPA finality before posting to Base, or how it handles a Base reorg. If a Base reorg drops the publish tx, the relayer presumably re-posts; the batch method exists for catch-up (https://docs.zkverify.io/architecture/proof-verification-smart-contract). The only finality guidance is app-level advice to treat `Finalized` as the threshold (https://docs.zkverify.io/handbook/four-paths/3d-consume-contracts/no-contract).
- **Input limits:** Groth16 accepts at most 64 public inputs ([N]`verifiers/groth16/src/lib.rs#L32`; https://docs.zkverify.io/architecture/supported_proofs). Our 13 are fine.

---

## Not found / open

- **Full mainnet role history.** Couldn't enumerate every `RoleGranted`/`RoleRevoked`/`Upgraded` event on Base mainnet: public RPCs cap `eth_getLogs` at 10k blocks, and Base Blockscout sits behind a Cloudflare challenge. Known holders come from the deploy tx and current `hasRole` checks only. There may be other holders.
- **Relayer finality / reorg policy.** Not documented. Unknown whether the bot waits for GRANDPA finality before publishing to Base.
- **`AggregationPublished` status.** Documented on docs.zkverify.io and in the OpenAPI schema, absent from Kurier's own status page, and never observed in the spike. Unresolved.
- **Official gas figures.** None published. All numbers above are our measurements (Base Sepolia fork and public `eth_estimateGas`). Mainnet gas should be within a few hundred gas, since the verify code is identical.
- **Mainnet latency** (submit → root on Base) not measured. Only the publish cadence was observed.
- **`submissionMode: "direct"`** appears in Kurier's `submit-proof` schema ("the proof will be sent to the destination chain") with no further docs. Not investigated; it may be an alternative to aggregation.
- **Byte order inside `hp_groth16::Scalar`**: not traced into that external crate. It rests on the Groth16 pallet doc ("Scalars are little-endian encoded") and on the leaf match we reproduced on chain.
