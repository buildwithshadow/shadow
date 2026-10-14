// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloatMainnetPublicBounded as Target} from "../src/ShadowFloatMainnetPublicBounded.sol";

interface VmCapacity {
    function expectEmit(bool, bool, bool, bool, address) external;
    function prank(address) external;
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

contract ShadowFloatPublicBoundedCapacityTest {
    VmCapacity constant vm = VmCapacity(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant PARKER = address(0xA11CE);
    address constant CUSTOMER = address(0xB0B);
    address constant PROVIDER = address(0xBEEF);
    uint256 constant PK = 1234;
    bytes32 constant ENDPOINT = keccak256("https://provider.example/report");
    MockAsset token;
    Target target;
    address agent;

    function setUp() public {
        vm.warp(1000);
        agent = vm.addr(PK);
        token = new MockAsset("USDC", "USDC", 6);
        Target.Limits memory limits = Target.Limits(1_000_000, 100_000, 5_000, 5_000, 5_000);
        target = new Target(address(token), block.chainid, limits, limits, 3600, 86400, 86400);
        target.setOpeningsPaused(false);
        target.setSpendsPaused(false);
        token.mint(PARKER, 1_000_000);
        token.mint(CUSTOMER, 100_000);
        vm.prank(PARKER);
        target.registerSponsor();
        vm.prank(PARKER);
        token.approve(address(target), 1_000_000);
        vm.prank(CUSTOMER);
        target.registerSponsor();
        vm.prank(CUSTOMER);
        token.approve(address(target), 100_000);
    }

    function params(address a, uint64 expiry) internal pure returns (Target.OpenLineParams memory) {
        return Target.OpenLineParams(a, 100_000, 5_000, 5_000, expiry, 86400, PROVIDER, ENDPOINT, 5_000, 5_000, expiry);
    }

    function open(uint64 expiry) internal returns (bytes32) {
        vm.prank(PARKER);
        return target.openLine(params(agent, expiry));
    }

    function fails(bytes memory data) internal {
        (bool ok,) = address(target).call(data);
        require(!ok, "unsafe call accepted");
    }

    function testDistantOpeningRejectedWithoutTokenMovement() public {
        Target.OpenLineParams memory p = params(agent, uint64(block.timestamp + 8 days));
        vm.prank(PARKER);
        fails(abi.encodeCall(target.openLine, (p)));
        require(token.balanceOf(PARKER) == 1_000_000 && target.totalCommittedCapital() == 0);
    }

    function testDistantProviderExpiryRejected() public {
        Target.OpenLineParams memory p = params(agent, uint64(block.timestamp + 7 days));
        p.providerExpiry += 1;
        vm.prank(PARKER);
        fails(abi.encodeCall(target.openLine, (p)));
        require(target.totalCommittedCapital() == 0);
    }

    function testExactLifetimeBoundaryAccepted() public {
        bytes32 id = open(uint64(block.timestamp + 7 days));
        require(target.maximumLineExpiry(id) == 1000 + 7 days);
    }

    function testRollingTermExtensionCannotMoveOriginalMaximum() public {
        bytes32 id = open(uint64(block.timestamp + 2 days));
        vm.warp(block.timestamp + 1 days);
        vm.prank(PARKER);
        fails(abi.encodeCall(target.updateLineTerms, (id, 5000, 5000, uint64(1000 + 8 days), 86400)));
        vm.prank(PARKER);
        target.updateLineTerms(id, 5000, 5000, uint64(1000 + 7 days), 86400);
        require(target.maximumLineExpiry(id) == 1000 + 7 days);
    }

    function testProviderPolicyExtensionCannotMoveOriginalMaximum() public {
        bytes32 id = open(uint64(block.timestamp + 7 days));
        vm.warp(block.timestamp + 1 days);
        vm.prank(PARKER);
        fails(
            abi.encodeCall(target.setProviderPolicy, (id, PROVIDER, ENDPOINT, 5000, 5000, uint64(1000 + 8 days), true))
        );
        vm.prank(PARKER);
        target.setProviderPolicy(id, PROVIDER, ENDPOINT, 0, 0, 0, false);
    }

    function testExpiryCloseRefusedBeforeAndAtExactExpiry() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 id = open(expiry);
        fails(abi.encodeCall(target.closeExpiredLine, (id)));
        vm.warp(expiry);
        fails(abi.encodeCall(target.closeExpiredLine, (id)));
        require(target.totalCommittedCapital() == 100_000);
    }

    function testExpiredCloseReturnsOnlyToSponsorWithPausesAndRevocation() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 id = open(expiry);
        target.setOpeningsPaused(true);
        target.setSpendsPaused(true);
        target.setSponsorAllowed(PARKER, false);
        vm.warp(expiry + 1);
        vm.prank(CUSTOMER);
        target.closeExpiredLine(id);
        require(
            token.balanceOf(PARKER) == 1_000_000 && token.balanceOf(CUSTOMER) == 100_000
                && token.balanceOf(address(this)) == 0
        );
        require(target.totalCommittedCapital() == 0 && target.totalSponsorObligations() == 0);
        require(target.getLine(id).state == Target.LineState.CLOSED);
        fails(abi.encodeCall(target.closeExpiredLine, (id)));
    }

    event ExpiredLineClosed(bytes32 indexed lineId, address indexed caller, address indexed sponsor, uint256 amount);

    function testExpiryClosureRecordsCallerAndSponsor() public {
        bytes32 id = open(2000);
        vm.warp(2001);
        vm.expectEmit(true, true, true, true, address(target));
        emit ExpiredLineClosed(id, CUSTOMER, PARKER, 100_000);
        vm.prank(CUSTOMER);
        target.closeExpiredLine(id);
    }

    function testExpiredCloseReleasesCapacityForAnotherSponsor() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 first;
        for (uint256 i; i < 10; i++) {
            vm.prank(PARKER);
            bytes32 id = target.openLine(params(address(uint160(100 + i)), expiry));
            if (i == 0) first = id;
        }
        require(target.totalCommittedCapital() == 1_000_000);
        vm.warp(expiry + 1);
        vm.prank(CUSTOMER);
        target.closeExpiredLine(first);
        vm.prank(CUSTOMER);
        target.openLine(params(CUSTOMER, uint64(uint256(expiry) + 1 + 1 days)));
        require(target.totalCommittedCapital() == 1_000_000);
    }

    function testDrawnExpiredLineCannotBeClosedOrRedirected() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 id = open(expiry);
        Target.Line memory line = target.getLine(id);
        Target.SpendIntent memory intent = Target.SpendIntent(
            agent,
            PARKER,
            id,
            line.epoch,
            target.currentTermsHash(id, PROVIDER),
            PROVIDER,
            ENDPOINT,
            5000,
            5000,
            block.timestamp + 1 hours,
            1,
            block.timestamp + 1 hours,
            address(0)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, target.hashSpendIntent(intent));
        (bool paid,) = target.executeSpend(intent, bytes.concat(r, s, bytes1(v)));
        require(paid);
        vm.warp(expiry + 1);
        vm.prank(CUSTOMER);
        fails(abi.encodeCall(target.closeExpiredLine, (id)));
        require(target.getLine(id).principalOutstanding == 5000 && target.getLine(id).availableReserve == 95_000);
        require(token.balanceOf(PROVIDER) == 5000 && token.balanceOf(CUSTOMER) == 100_000);
    }

    function testNonexistentLineCannotReleaseFunds() public {
        fails(abi.encodeCall(target.closeExpiredLine, (bytes32(uint256(123)))));
        require(target.totalCommittedCapital() == 0);
    }

    function testFuzzExpiredReturnAndAccounting(uint32 raw) public {
        uint256 reserve = 5000 + uint256(raw) % 95001;
        uint64 expiry = uint64(block.timestamp + 1 days);
        Target.OpenLineParams memory p = params(agent, expiry);
        p.reserve = reserve;
        vm.prank(PARKER);
        bytes32 id = target.openLine(p);
        vm.warp(expiry + 1);
        vm.prank(CUSTOMER);
        target.closeExpiredLine(id);
        require(
            token.balanceOf(PARKER) == 1_000_000 && target.totalCommittedCapital() == 0
                && target.totalSponsorObligations() == 0 && token.balanceOf(address(target)) == 0
        );
    }
}
