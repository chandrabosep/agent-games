// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IZkVerifyAggregation, ZkVerifyLeaf} from "./ZkVerifyLeaf.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title PolicyVault
/// @notice An AI agent's wallet that checks every transaction before it runs. The agent never holds
/// the funds; it can only ask the vault to act, and the vault refuses anything outside its rules.
///
/// Two layers of rules:
///
/// 1. **Public rules, checked here instantly, no proof.** Every call the agent makes goes through
///    `execute`. It refuses ETH transfers, `setApprovalForAll`, unlimited approvals, any call that
///    touches a blocklisted address, and anything that isn't a plain `transfer` or `approve` of the
///    vault's token. Small transfers and approvals pass at once, up to a public per-call cap and
///    a public daily budget.
///
/// 2. **A hidden policy, checked with a zero-knowledge proof via zkVerify.** Anything above the
///    instant budget needs `pay`. The owner stores only a Poseidon commitment to a policy: a
///    per-payment limit, an expiry and an allowlist of recipients. The agent proves (Groth16,
///    circuit wildcard/circuits/policy_payment.circom) that the payment fits it, zkVerify verifies
///    the proof and publishes it in an aggregation on this chain, and `pay` rebuilds the proof's
///    public inputs from its own arguments and state. So a proof only ever authorizes the exact
///    payment it was made for, on this vault and this chain, once.
///
/// The owner (a separate key, never given to the agent) sets the rules and can always withdraw.
contract PolicyVault {
    /// @dev BN254 scalar field. Every public input must be a canonical field element.
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @dev setApprovalForAll(address,bool): the NFT-drainer favourite.
    bytes4 internal constant SET_APPROVAL_FOR_ALL = 0xa22cb465;

    IZkVerifyAggregation public immutable zkVerify;
    IERC20 public immutable token;
    /// @notice zkVerify's hash of the policy_payment verification key.
    bytes32 public immutable vkHash;
    /// @notice zkVerify aggregation domain that publishes to this chain.
    uint256 public immutable domainId;

    address public owner;
    /// @notice The only address that may call `execute`. `pay` needs a proof, so anyone may call it.
    address public agent;
    uint256 public policyCommitment;
    mapping(uint256 nonce => bool) public nonceUsed;

    /// @notice Public rules: addresses the vault never sends to, approves or calls.
    mapping(address => bool) public blocked;
    /// @notice Largest single instant (proof-free) transfer or approval, in token units.
    uint256 public instantCap;
    /// @notice Total instant transfers and approvals per UTC day, in token units.
    uint256 public dailyCap;
    uint256 public spentDay;
    uint256 public spentToday;

    event PolicyCommitted(uint256 commitment);
    event Paid(uint256 indexed nonce, address indexed recipient, uint256 amount, uint256 aggregationId, bytes32 leaf);
    event Executed(bytes4 indexed selector, address indexed counterparty, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnerChanged(address indexed owner);
    event AgentChanged(address indexed agent);
    event InstantLimitsChanged(uint256 instantCap, uint256 dailyCap);
    event BlockedChanged(address indexed who, bool blocked);

    error NotOwner();
    error NotAgent();
    error NotFieldElement();
    error PaymentExpired();
    error NonceAlreadyUsed();
    error ProofNotAggregated();
    error TransferFailed();
    // Public rules. Each names the rule that refused the call.
    error BlockedEthTransfer();
    error BlockedApprovalForAll();
    error BlockedUnlimitedApproval();
    error BlockedAddress(address who);
    error UnsupportedCall();
    error OverInstantLimit();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IZkVerifyAggregation zkVerify_,
        IERC20 token_,
        bytes32 vkHash_,
        uint256 domainId_,
        uint256 commitment_,
        address agent_,
        uint256 instantCap_,
        uint256 dailyCap_
    ) {
        if (commitment_ >= SNARK_FIELD) revert NotFieldElement();
        zkVerify = zkVerify_;
        token = token_;
        vkHash = vkHash_;
        domainId = domainId_;
        owner = msg.sender;
        agent = agent_;
        policyCommitment = commitment_;
        instantCap = instantCap_;
        dailyCap = dailyCap_;
        emit OwnerChanged(msg.sender);
        emit AgentChanged(agent_);
        emit PolicyCommitted(commitment_);
        emit InstantLimitsChanged(instantCap_, dailyCap_);
    }

    // ---- Owner ----

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

    function setAgent(address newAgent) external onlyOwner {
        agent = newAgent;
        emit AgentChanged(newAgent);
    }

    function setInstantLimits(uint256 instantCap_, uint256 dailyCap_) external onlyOwner {
        instantCap = instantCap_;
        dailyCap = dailyCap_;
        emit InstantLimitsChanged(instantCap_, dailyCap_);
    }

    function setBlocked(address who, bool isBlocked) external onlyOwner {
        blocked[who] = isBlocked;
        emit BlockedChanged(who, isBlocked);
    }

    /// @notice The owner can always take the funds back; the rules only limit the agent.
    function withdraw(address to, uint256 amount) external onlyOwner {
        _transfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ---- Layer 1: the public rules ----

    /// @notice What is left of today's instant budget, capped by the per-call limit.
    function instantRemaining() public view returns (uint256) {
        uint256 spent = spentDay == block.timestamp / 1 days ? spentToday : 0;
        uint256 left = dailyCap > spent ? dailyCap - spent : 0;
        return left < instantCap ? left : instantCap;
    }

    /// @notice Run a transaction for the agent if the public rules allow it. Reverts with the rule
    /// that refused it; `OverInstantLimit` means a transfer needs a policy proof (`pay`) instead.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != agent) revert NotAgent();
        if (value != 0) revert BlockedEthTransfer();
        if (data.length < 4) revert UnsupportedCall();
        bytes4 selector = bytes4(data[:4]);
        if (blocked[target]) revert BlockedAddress(target);

        if (selector == SET_APPROVAL_FOR_ALL) {
            if (data.length < 68) revert UnsupportedCall();
            (address operator, bool approved) = abi.decode(data[4:], (address, bool));
            if (approved) revert BlockedApprovalForAll();
            if (blocked[operator]) revert BlockedAddress(operator);
            revert UnsupportedCall(); // the vault holds no NFTs; nothing to revoke
        }
        if (selector != IERC20.transfer.selector && selector != IERC20.approve.selector) revert UnsupportedCall();
        if (data.length != 68) revert UnsupportedCall();
        (address counterparty, uint256 amount) = abi.decode(data[4:], (address, uint256));
        if (selector == IERC20.approve.selector && amount == type(uint256).max) revert BlockedUnlimitedApproval();
        if (blocked[counterparty]) revert BlockedAddress(counterparty);
        if (target != address(token)) revert UnsupportedCall();

        _spendInstant(amount);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        emit Executed(selector, counterparty, amount);
        return ret;
    }

    function _spendInstant(uint256 amount) private {
        uint256 day = block.timestamp / 1 days;
        if (spentDay != day) {
            spentDay = day;
            spentToday = 0;
        }
        if (amount > instantCap || spentToday + amount > dailyCap) revert OverInstantLimit();
        spentToday += amount;
    }

    // ---- Layer 2: the hidden policy, proven via zkVerify ----

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
    /// this payment. Anyone may call it: the proof, not the caller, authorizes the payment. The
    /// public blocklist still applies.
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
        if (blocked[recipient]) revert BlockedAddress(recipient);

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
