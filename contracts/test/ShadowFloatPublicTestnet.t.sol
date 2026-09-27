// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ShadowFloatPublicTestnet} from "../src/ShadowFloatPublicTestnet.sol";
import {ShadowFloatMainnet} from "../src/ShadowFloatMainnet.sol";
import {MockAsset} from "../src/MockAsset.sol";

interface VmPublicTestnet {
    function chainId(uint256) external;
    function prank(address) external;
}

contract ShadowFloatPublicTestnetTest {
    VmPublicTestnet constant vm = VmPublicTestnet(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockAsset token;
    ShadowFloatPublicTestnet target;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    function limits() internal pure returns (ShadowFloatMainnet.Limits memory) {
        return ShadowFloatMainnet.Limits(25e6, 5e6, 5e6, 1e6, 2e6);
    }

    function setUp() public {
        vm.chainId(5042002);
        token = new MockAsset("USDC", "USDC", 6);
        target = new ShadowFloatPublicTestnet(address(token), limits(), limits(), 60, 7 days, 1 days);
    }

    function testAnyoneCanRegisterOnlyTheirOwnWallet() public {
        vm.prank(ALICE);
        target.registerSponsor();
        require(target.sponsorAllowed(ALICE) && !target.sponsorAllowed(BOB), "wrong admission");
        vm.prank(ALICE);
        target.registerSponsor();
        vm.prank(ALICE);
        (bool ok,) = address(target).call(abi.encodeCall(target.setSponsorAllowed, (BOB, true)));
        require(!ok, "non-owner admitted another wallet");
    }

    function testRevokedSponsorCannotReregisterUntilOwnerRestores() public {
        // Covers a denial before first registration as well as a later revocation.
        target.setSponsorAllowed(ALICE, false);
        vm.prank(ALICE);
        (bool ok,) = address(target).call(abi.encodeCall(target.registerSponsor, ()));
        require(!ok && !target.sponsorAllowed(ALICE), "revocation bypass");
        target.setSponsorAllowed(ALICE, true);
        vm.prank(ALICE);
        target.registerSponsor();
        target.setSponsorAllowed(ALICE, false);
        vm.prank(ALICE);
        (ok,) = address(target).call(abi.encodeCall(target.registerSponsor, ()));
        require(!ok, "second revocation bypass");
    }

    function testPausePreventsNewAdmission() public {
        target.setOpeningsPaused(true);
        vm.prank(ALICE);
        (bool ok,) = address(target).call(abi.encodeCall(target.registerSponsor, ()));
        require(!ok && !target.sponsorAllowed(ALICE), "pause bypass");
    }

    function testCannotDeployOnMainnet() public {
        vm.chainId(5042);
        try new ShadowFloatPublicTestnet(address(token), limits(), limits(), 60, 7 days, 1 days) {
            revert("mainnet deployment accepted");
        } catch {}
    }

    function testSelfServiceFundingPullsOnlySponsorsOwnTokens() public {
        token.mint(ALICE, 1e6);
        vm.prank(ALICE);
        target.registerSponsor();
        vm.prank(ALICE);
        token.approve(address(target), 100000);
        ShadowFloatMainnet.OpenLineParams memory p = ShadowFloatMainnet.OpenLineParams({
            agent: BOB,
            reserve: 100000,
            lineSpendCap: 100000,
            dailySpendCap: 100000,
            lineExpiry: uint64(block.timestamp + 1 days),
            maximumRepaymentWindow: 1 hours,
            provider: address(0xCAFE),
            endpointHash: keccak256("service"),
            providerPerSpendCap: 50000,
            providerDailyCap: 100000,
            providerExpiry: uint64(block.timestamp + 1 days)
        });
        vm.prank(ALICE);
        bytes32 lineId = target.openLine(p);
        require(lineId == target.activeLineId(ALICE, BOB), "wrong ownership");
        require(token.balanceOf(ALICE) == 900000 && token.balanceOf(address(target)) == 100000, "wrong source");
        vm.prank(BOB);
        target.registerSponsor();
        vm.prank(BOB);
        (bool ok,) = address(target).call(abi.encodeCall(target.openLine, (p)));
        require(!ok && token.balanceOf(ALICE) == 900000, "used another sponsor balance");
    }
}
