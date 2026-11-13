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

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
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
    bytes32[] empty;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_790_000_000);
        zkv = new MockZkVerify();
        usdc = new MockToken();
        vault = new PolicyVault(zkv, usdc, VK, 2, COMMITMENT);
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
        PolicyVault other = new PolicyVault(zkv, usdc, VK, 2, COMMITMENT);
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
