// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloatMainnetPublic} from "../src/ShadowFloatMainnetPublic.sol";

interface VmAdmission {
    function prank(address) external;
}

contract ShadowFloatPublicAdmissionTest {
    VmAdmission constant vm = VmAdmission(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    MockAsset token;
    ShadowFloatMainnetPublic target;

    function setUp() public {
        token = new MockAsset("USDC", "USDC", 6);
        ShadowFloatMainnetPublic.Limits memory limits =
            ShadowFloatMainnetPublic.Limits(1_000_000, 100_000, 5_000, 5_000, 5_000);
        target = new ShadowFloatMainnetPublic(address(token), block.chainid, limits, limits, 3600, 86400, 86400);
        token.mint(ALICE, 100_000);
    }

    function registerAlice() internal {
        target.setOpeningsPaused(false);
        vm.prank(ALICE);
        target.registerSponsor();
    }

    function testCallerOnlyRegistrationMovesNoFundsAndIsIdempotent() public {
        registerAlice();
        require(target.sponsorAllowed(ALICE) && !target.sponsorAllowed(BOB));
        require(token.balanceOf(ALICE) == 100_000 && token.balanceOf(address(target)) == 0);
        require(token.allowance(ALICE, address(target)) == 0 && target.totalCommittedCapital() == 0);
        require(target.spendsPaused());
        vm.prank(ALICE);
        target.registerSponsor();
        require(target.totalSponsorObligations() == 0);
    }

    function testRegistrationCannotBypassPause() public {
        vm.prank(ALICE);
        (bool ok,) = address(target).call(abi.encodeCall(target.registerSponsor, ()));
        require(!ok && !target.sponsorAllowed(ALICE));
    }

    function testRevokedSponsorCannotReregisterUntilOwnerReadmits() public {
        registerAlice();
        target.setSponsorAllowed(ALICE, false);
        vm.prank(ALICE);
        (bool ok,) = address(target).call(abi.encodeCall(target.registerSponsor, ()));
        require(!ok && !target.sponsorAllowed(ALICE));
        target.setSponsorAllowed(ALICE, true);
        vm.prank(ALICE);
        target.registerSponsor();
        require(target.sponsorAllowed(ALICE) && !target.sponsorAdmissionRevoked(ALICE));
    }

    function testRegistrationGrantsNoGovernanceOrOtherWalletAdmission() public {
        registerAlice();
        vm.prank(ALICE);
        (bool ok,) = address(target).call(abi.encodeCall(target.setSponsorAllowed, (BOB, true)));
        require(!ok && !target.sponsorAllowed(BOB));
        vm.prank(ALICE);
        (ok,) = address(target).call(abi.encodeCall(target.setSpendsPaused, (false)));
        require(!ok && target.spendsPaused());
    }

    function params() internal view returns (ShadowFloatMainnetPublic.OpenLineParams memory) {
        return ShadowFloatMainnetPublic.OpenLineParams(
            ALICE,
            100_000,
            5_000,
            5_000,
            uint64(block.timestamp + 7 days),
            86400,
            address(0xBEEF),
            keccak256("https://provider.example/report"),
            5_000,
            5_000,
            uint64(block.timestamp + 7 days)
        );
    }

    function testFreshSponsorSelfFundsAndReclaimsWithoutOperator() public {
        registerAlice();
        vm.prank(ALICE);
        token.approve(address(target), 100_000);
        ShadowFloatMainnetPublic.OpenLineParams memory p = params();
        vm.prank(ALICE);
        bytes32 id = target.openLine(p);
        require(token.balanceOf(ALICE) == 0 && token.balanceOf(address(target)) == 100_000);
        vm.prank(BOB);
        (bool ok,) = address(target).call(abi.encodeCall(target.closeLine, (id)));
        require(!ok);
        target.setOpeningsPaused(true);
        vm.prank(ALICE);
        target.closeLine(id);
        require(token.balanceOf(ALICE) == 100_000 && token.balanceOf(address(target)) == 0);
        require(target.totalCommittedCapital() == 0 && target.totalSponsorObligations() == 0);
    }

    function testRegistrationDoesNotRelaxLimits() public {
        registerAlice();
        vm.prank(ALICE);
        token.approve(address(target), 100_000);
        ShadowFloatMainnetPublic.OpenLineParams memory p = params();
        p.reserve = 100_001;
        vm.prank(ALICE);
        (bool ok,) = address(target).call(abi.encodeCall(target.openLine, (p)));
        require(!ok && token.balanceOf(ALICE) == 100_000);
        p = params();
        p.providerPerSpendCap = 5_001;
        vm.prank(ALICE);
        (ok,) = address(target).call(abi.encodeCall(target.openLine, (p)));
        require(!ok && target.totalCommittedCapital() == 0);
    }
}
