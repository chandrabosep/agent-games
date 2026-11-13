// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice zkVerify's aggregation contract (one proxy per destination chain).
/// Signature from zkVerify/zkv-attestation-contracts `IVerifyProofAggregation.sol`.
interface IZkVerifyAggregation {
    function verifyProofAggregation(
        uint256 domainId,
        uint256 aggregationId,
        bytes32 leaf,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 index
    ) external view returns (bool);
}

/// @notice The leaf zkVerify puts in an aggregation for a Groth16 proof (the pallet's statement hash):
/// keccak256(keccak256("groth16") ‖ vkHash ‖ versionHash ‖ keccak256(LE32(input_0) ‖ … ‖ LE32(input_n)))
/// Each public input is a 32-byte word with its bytes reversed (little-endian scalars).
/// versionHash is sha256(""), the pallet's NO_VERSION_HASH; Groth16 has no versions.
/// See docs/zkverify-onchain-check.md. Tested against a leaf Kurier returned for a real proof.
library ZkVerifyLeaf {
    bytes32 internal constant GROTH16 = keccak256("groth16");
    bytes32 internal constant NO_VERSION_HASH = 0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855;

    function groth16(bytes32 vkHash, uint256[] memory inputs) internal pure returns (bytes32) {
        bytes memory enc = new bytes(inputs.length * 32);
        for (uint256 i = 0; i < inputs.length; i++) {
            bytes32 word = reverseBytes(inputs[i]);
            assembly {
                mstore(add(add(enc, 32), mul(i, 32)), word)
            }
        }
        return keccak256(abi.encodePacked(GROTH16, vkHash, NO_VERSION_HASH, keccak256(enc)));
    }

    /// @dev Reverses the 32 bytes of v. (The zkVerify docs tutorial's version shifts right by
    /// 1/2/3/4 instead of 8/16/32/64; don't copy it.)
    function reverseBytes(uint256 v) internal pure returns (bytes32) {
        v = ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8)
            | ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16)
            | ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        v = ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32)
            | ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        v = ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64)
            | ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        v = (v >> 128) | (v << 128);
        return bytes32(v);
    }
}
