// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyVault, IERC20} from "../src/PolicyVault.sol";
import {IZkVerifyAggregation, ZkVerifyLeaf} from "../src/ZkVerifyLeaf.sol";

/// Stands in for zkVerify: a leaf counts as aggregated once `publish` is called for it.
contract MockZkVerify is IZkVerifyAggregation {
    mapping(bytes32 => bool) public published;
    uint256 public constant DOMAIN = 2;
    uint256 public constant AGG = 77;

    function publish(bytes32 leaf) external {
        published[leaf] = true;
    }

    function verifyProofAggregation(uint256 d, uint256 a, bytes32 leaf, bytes32[] calldata, uint256, uint256)
        external
        view
        returns (bool)
    {
        return d == DOMAIN && a == AGG && published[leaf];
    }
}

contract MockToken is IERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    mapping(address => mapping(address => uint256)) public allowance;

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

/// Exposes the internal library for testing.
contract LeafHarness {
    function groth16(bytes32 vkHash, uint256[] memory inputs) external pure returns (bytes32) {
        return ZkVerifyLeaf.groth16(vkHash, inputs);
    }
}

contract PolicyVaultTest is Test {
    MockZkVerify zkv;
    MockToken usdc;
    PolicyVault vault;

    bytes32 constant VK = keccak256("policy_payment vk");
    uint256 constant COMMITMENT = 12345;
    address constant VENDOR = address(0xBEEF);
    address constant AGENT = address(0xA6E7);
    address constant DRAINER = address(0xD7A1);
    uint256 constant INSTANT = 25e6;
    uint256 constant DAILY = 60e6;
    bytes32[] empty;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_790_000_000);
        zkv = new MockZkVerify();
        usdc = new MockToken();
        vault = new PolicyVault(zkv, usdc, VK, 2, COMMITMENT, AGENT, INSTANT, DAILY);
        vault.setBlocked(DRAINER, true);
        usdc.mint(address(vault), 1_000e6);
    }

    function _publish(uint256 amount, uint256 nonce, uint256 validUntil) internal returns (bytes32 leaf) {
        leaf = vault.leafFor(VENDOR, amount, nonce, validUntil);
        zkv.publish(leaf);
    }

    function _pay(uint256 amount, uint256 nonce, uint256 validUntil) internal {
        vault.pay(VENDOR, amount, nonce, validUntil, 77, empty, 1, 0);
    }

    // The leaf formula, checked against a leaf Kurier returned for a real Gatekeeper proof
    // (spike/out/job-a580d3ba-….json: aggregation 64987 on Base Sepolia).
    function test_leafMatchesKurier() public {
        uint256[] memory s = new uint256[](13);
        s[0] = 5159209261604496338057099923251677359437788295215516717881494780951457243165;
        s[1] = 999; s[2] = 999; s[3] = 1000; s[4] = 1460; s[5] = 19842201; s[6] = 19832000;
        s[7] = 111; s[8] = 111; s[9] = 500; s[10] = 1000; s[11] = 1; s[12] = 1794584016440;
        bytes32 vk = 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0;
        assertEq(
            new LeafHarness().groth16(vk, s), 0x95b00e606273fac7d20936d073ed3a257d3c04b6ab4aa1433cbbd1d077387138
        );
    }

    function test_reverseBytes() public pure {
        assertEq(ZkVerifyLeaf.reverseBytes(1), bytes32(uint256(1) << 248));
        assertEq(ZkVerifyLeaf.reverseBytes(0x0102), bytes32(uint256(0x0201) << 240));
    }

    function test_publicInputsOrder() public view {
        uint256[] memory i = vault.publicInputs(VENDOR, 5, 6, 7);
        assertEq(i.length, 7);
        assertEq(i[0], COMMITMENT);
        assertEq(i[1], uint256(uint160(VENDOR)));
        assertEq(i[2], 5);
        assertEq(i[3], 6);
        assertEq(i[4], 7);
        assertEq(i[5], uint256(uint160(address(vault))));
        assertEq(i[6], 84532);
    }

    function test_paysWhenProofAggregated() public {
        _publish(120e6, 1, block.timestamp + 600);
        _pay(120e6, 1, block.timestamp + 600);
        assertEq(usdc.balanceOf(VENDOR), 120e6);
        assertTrue(vault.nonceUsed(1));
    }

    function test_refusesWithoutProof() public {
        vm.expectRevert(PolicyVault.ProofNotAggregated.selector);
        _pay(120e6, 1, block.timestamp + 600);
    }

    function test_proofOnlyCoversItsExactPayment() public {
        _publish(120e6, 1, block.timestamp + 600);
        vm.expectRevert(PolicyVault.ProofNotAggregated.selector);
        _pay(121e6, 1, block.timestamp + 600); // different amount
        vm.expectRevert(PolicyVault.ProofNotAggregated.selector);
        vault.pay(address(0xBAD), 120e6, 1, block.timestamp + 600, 77, empty, 1, 0); // different recipient
    }

    function test_refusesReplay() public {
        _publish(120e6, 1, block.timestamp + 600);
        _pay(120e6, 1, block.timestamp + 600);
        vm.expectRevert(PolicyVault.NonceAlreadyUsed.selector);
        _pay(120e6, 1, block.timestamp + 600);
    }

    function test_refusesAfterDeadline() public {
        uint256 until = block.timestamp + 600;
        _publish(120e6, 1, until);
        vm.warp(until + 1);
        vm.expectRevert(PolicyVault.PaymentExpired.selector);
        _pay(120e6, 1, until);
    }

    function test_newPolicyRevokesOldProofs() public {
        _publish(120e6, 1, block.timestamp + 600);
        vault.setPolicy(999);
        vm.expectRevert(PolicyVault.ProofNotAggregated.selector);
        _pay(120e6, 1, block.timestamp + 600);
    }

    function test_proofIsBoundToVaultAndChain() public {
        bytes32 leaf = _publish(120e6, 1, block.timestamp + 600);
        PolicyVault other = new PolicyVault(zkv, usdc, VK, 2, COMMITMENT, AGENT, INSTANT, DAILY);
        assertTrue(other.leafFor(VENDOR, 120e6, 1, block.timestamp + 600) != leaf);
        vm.chainId(8453);
        assertTrue(vault.leafFor(VENDOR, 120e6, 1, block.timestamp + 600) != leaf);
    }

    function test_onlyOwnerManagesPolicyAndFunds() public {
        vm.startPrank(address(0xA11CE));
        vm.expectRevert(PolicyVault.NotOwner.selector);
        vault.setPolicy(1);
        vm.expectRevert(PolicyVault.NotOwner.selector);
        vault.withdraw(address(0xA11CE), 1);
        vm.expectRevert(PolicyVault.NotOwner.selector);
        vault.setBlocked(DRAINER, false);
        vm.expectRevert(PolicyVault.NotOwner.selector);
        vault.setInstantLimits(1e30, 1e30);
        vm.expectRevert(PolicyVault.NotOwner.selector);
        vault.setAgent(address(0xA11CE));
        vm.stopPrank();
        // The agent is not the owner: a hijacked agent cannot withdraw or loosen the rules.
        vm.startPrank(AGENT);
        vm.expectRevert(PolicyVault.NotOwner.selector);
        vault.withdraw(AGENT, 1);
        vm.expectRevert(PolicyVault.NotOwner.selector);
        vault.setInstantLimits(1e30, 1e30);
        vm.stopPrank();
        vault.withdraw(address(this), 10e6);
        assertEq(usdc.balanceOf(address(this)), 10e6);
    }

    function test_rejectsNonFieldInputs() public {
        uint256 p = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        vm.expectRevert(PolicyVault.NotFieldElement.selector);
        vault.pay(VENDOR, 1, p, block.timestamp + 600, 77, empty, 1, 0);
        vm.expectRevert(PolicyVault.NotFieldElement.selector);
        vault.setPolicy(p);
    }

    // ---- Layer 1: public rules on execute ----

    function _exec(address target, bytes memory data) internal {
        vm.prank(AGENT);
        vault.execute(target, 0, data);
    }

    function _transferCall(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.transfer, (to, amount));
    }

    function test_instantTransferWithinBudget() public {
        _exec(address(usdc), _transferCall(VENDOR, 20e6));
        assertEq(usdc.balanceOf(VENDOR), 20e6);
        assertEq(vault.instantRemaining(), 25e6); // 40 left today, capped at 25 per call
        _exec(address(usdc), _transferCall(VENDOR, 25e6));
        assertEq(vault.instantRemaining(), 15e6);
    }

    function test_instantBudgetIsPerCallAndPerDay() public {
        vm.prank(AGENT);
        vm.expectRevert(PolicyVault.OverInstantLimit.selector);
        vault.execute(address(usdc), 0, _transferCall(VENDOR, 25e6 + 1));
        _exec(address(usdc), _transferCall(VENDOR, 25e6));
        _exec(address(usdc), _transferCall(VENDOR, 25e6));
        vm.prank(AGENT);
        vm.expectRevert(PolicyVault.OverInstantLimit.selector);
        vault.execute(address(usdc), 0, _transferCall(VENDOR, 10e6 + 1)); // 60 a day
        vm.warp(block.timestamp + 1 days);
        _exec(address(usdc), _transferCall(VENDOR, 25e6)); // new day, new budget
        assertEq(usdc.balanceOf(VENDOR), 75e6);
    }

    function test_onlyAgentMayExecute() public {
        vm.expectRevert(PolicyVault.NotAgent.selector);
        vault.execute(address(usdc), 0, _transferCall(VENDOR, 1));
    }

    function test_blocksUnlimitedApproval() public {
        vm.prank(AGENT);
        vm.expectRevert(PolicyVault.BlockedUnlimitedApproval.selector);
        vault.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (VENDOR, type(uint256).max)));
    }

    function test_smallApprovalCountsAgainstBudgetAndRevokeIsFree() public {
        _exec(address(usdc), abi.encodeCall(IERC20.approve, (VENDOR, 20e6)));
        assertEq(usdc.allowance(address(vault), VENDOR), 20e6);
        _exec(address(usdc), abi.encodeCall(IERC20.approve, (VENDOR, 0)));
        assertEq(usdc.allowance(address(vault), VENDOR), 0);
        assertEq(vault.instantRemaining(), 25e6);
        assertEq(vault.spentToday(), 20e6);
    }

    function test_blocksSetApprovalForAll() public {
        vm.prank(AGENT);
        vm.expectRevert(PolicyVault.BlockedApprovalForAll.selector);
        vault.execute(address(0x1234), 0, abi.encodeWithSelector(0xa22cb465, VENDOR, true));
    }

    function test_blocksBlocklistedAddresses() public {
        vm.startPrank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.BlockedAddress.selector, DRAINER));
        vault.execute(address(usdc), 0, _transferCall(DRAINER, 1));
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.BlockedAddress.selector, DRAINER));
        vault.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (DRAINER, 1)));
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.BlockedAddress.selector, DRAINER));
        vault.execute(DRAINER, 0, hex"12345678");
        vm.stopPrank();
    }

    function test_blocklistAppliesToProofPayments() public {
        uint256 until = block.timestamp + 600;
        zkv.publish(vault.leafFor(DRAINER, 120e6, 1, until));
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.BlockedAddress.selector, DRAINER));
        vault.pay(DRAINER, 120e6, 1, until, 77, empty, 1, 0);
    }

    function test_blocksEthAndUnknownCalls() public {
        vm.deal(address(vault), 1 ether);
        vm.startPrank(AGENT);
        vm.expectRevert(PolicyVault.BlockedEthTransfer.selector);
        vault.execute(VENDOR, 1, "");
        vm.expectRevert(PolicyVault.UnsupportedCall.selector);
        vault.execute(address(usdc), 0, hex"23b872dd"); // transferFrom selector, no args
        vm.expectRevert(PolicyVault.UnsupportedCall.selector);
        vault.execute(address(0x1234), 0, _transferCall(VENDOR, 1)); // some other token
        vm.expectRevert(PolicyVault.UnsupportedCall.selector);
        vault.execute(address(usdc), 0, abi.encodePacked(_transferCall(VENDOR, 1), uint256(7))); // trailing bytes
        vm.stopPrank();
    }

    function test_ownerSetsRules() public {
        vault.setInstantLimits(0, 0);
        vm.prank(AGENT);
        vm.expectRevert(PolicyVault.OverInstantLimit.selector);
        vault.execute(address(usdc), 0, _transferCall(VENDOR, 1));
        vault.setAgent(address(0xA6E8));
        assertEq(vault.agent(), address(0xA6E8));
    }
}

/// Against the real zkVerify proxy on a Base Sepolia fork. Skipped unless FORK_TESTS=1.
contract ZkVerifyForkTest is Test {
    function test_realProxyAcceptsOurLeaf() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork("base_sepolia", 58311700);
        uint256[] memory s = new uint256[](13);
        s[0] = 5159209261604496338057099923251677359437788295215516717881494780951457243165;
        s[1] = 999; s[2] = 999; s[3] = 1000; s[4] = 1460; s[5] = 19842201; s[6] = 19832000;
        s[7] = 111; s[8] = 111; s[9] = 500; s[10] = 1000; s[11] = 1; s[12] = 1794584016440;
        bytes32 leaf = new LeafHarness().groth16(0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0, s);
        bytes32[] memory path;
        assertTrue(
            IZkVerifyAggregation(0x0807C544D38aE7729f8798388d89Be6502A1e8A8).verifyProofAggregation(
                2, 64987, leaf, path, 1, 0
            )
        );
    }
}
