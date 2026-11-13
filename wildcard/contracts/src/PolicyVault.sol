// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IZkVerifyAggregation, ZkVerifyLeaf} from "./ZkVerifyLeaf.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title PolicyVault
/// @notice Holds a token for an AI agent and pays out only what a hidden policy allows.
///
/// The owner stores a Poseidon commitment to a policy: a per-payment limit, an expiry and an
/// allowlist of recipients. The policy itself never goes on chain. For each payment the agent
/// proves (Groth16, circuit wildcard/circuits/policy_payment.circom) that the payment fits the
/// committed policy, and zkVerify verifies that proof and publishes it in an aggregation on this
/// chain. `pay` rebuilds the proof's public inputs from its own arguments and state, so a proof
/// only ever authorizes the exact payment it was made for, on this vault and this chain, once.
contract PolicyVault {
    /// @dev BN254 scalar field. Every public input must be a canonical field element.
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IZkVerifyAggregation public immutable zkVerify;
    IERC20 public immutable token;
    /// @notice zkVerify's hash of the policy_payment verification key.
    bytes32 public immutable vkHash;
    /// @notice zkVerify aggregation domain that publishes to this chain.
    uint256 public immutable domainId;

    address public owner;
    uint256 public policyCommitment;
    mapping(uint256 nonce => bool) public nonceUsed;

    event PolicyCommitted(uint256 commitment);
    event Paid(uint256 indexed nonce, address indexed recipient, uint256 amount, uint256 aggregationId, bytes32 leaf);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error NotFieldElement();
    error PaymentExpired();
    error NonceAlreadyUsed();
    error ProofNotAggregated();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IZkVerifyAggregation zkVerify_, IERC20 token_, bytes32 vkHash_, uint256 domainId_, uint256 commitment_) {
        if (commitment_ >= SNARK_FIELD) revert NotFieldElement();
        zkVerify = zkVerify_;
        token = token_;
        vkHash = vkHash_;
        domainId = domainId_;
        owner = msg.sender;
        policyCommitment = commitment_;
        emit OwnerChanged(msg.sender);
        emit PolicyCommitted(commitment_);
    }

    /// @notice Replace the policy. Proofs made against the old one stop working.
    function setPolicy(uint256 commitment) external onlyOwner {
        if (commitment >= SNARK_FIELD) revert NotFieldElement();
        policyCommitment = commitment;
        emit PolicyCommitted(commitment);
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    /// @notice The owner can always take the funds back; the policy only limits the agent.
    function withdraw(address to, uint256 amount) external onlyOwner {
        _transfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice The proof's public inputs, in the circuit's order.
    function publicInputs(address recipient, uint256 amount, uint256 nonce, uint256 validUntil)
        public
        view
        returns (uint256[] memory inputs)
    {
        inputs = new uint256[](7);
        inputs[0] = policyCommitment;
        inputs[1] = uint256(uint160(recipient));
        inputs[2] = amount;
        inputs[3] = nonce;
        inputs[4] = validUntil;
        inputs[5] = uint256(uint160(address(this)));
        inputs[6] = block.chainid;
    }

    /// @notice The zkVerify leaf a proof for this payment must have.
    function leafFor(address recipient, uint256 amount, uint256 nonce, uint256 validUntil)
        public
        view
        returns (bytes32)
    {
        return ZkVerifyLeaf.groth16(vkHash, publicInputs(recipient, amount, nonce, validUntil));
    }

    /// @notice Pay `amount` to `recipient` if zkVerify has aggregated a valid policy proof for exactly
    /// this payment. Anyone may call it: the proof, not the caller, authorizes the payment.
    /// @param aggregationId, merklePath, leafCount, index: where the proof sits in the aggregation
    /// (Kurier's job-status `aggregationDetails` returns them).
    function pay(
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 validUntil,
        uint256 aggregationId,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 index
    ) external {
        if (block.timestamp > validUntil) revert PaymentExpired();
        if (amount >= SNARK_FIELD || nonce >= SNARK_FIELD || validUntil >= SNARK_FIELD) revert NotFieldElement();
        if (nonceUsed[nonce]) revert NonceAlreadyUsed();

        bytes32 leaf = leafFor(recipient, amount, nonce, validUntil);
        if (!zkVerify.verifyProofAggregation(domainId, aggregationId, leaf, merklePath, leafCount, index)) {
            revert ProofNotAggregated();
        }

        nonceUsed[nonce] = true;
        _transfer(recipient, amount);
        emit Paid(nonce, recipient, amount, aggregationId, leaf);
    }

    function _transfer(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
