// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloatMainnetPublicSettled as Target} from "../src/ShadowFloatMainnetPublicSettled.sol";

interface VmSettledRemediation {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function prank(address) external;
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract ShadowFloatMainnetPublicSettledRemediationTest {
    VmSettledRemediation constant vm = VmSettledRemediation(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant SPONSOR = address(0xA11CE);
    address constant CUSTOMER = address(0xB0B);
    address constant PAYER = address(0xCAFE);
    address constant CALLER = address(0xCA11);
    bytes32 constant ENDPOINT = keccak256("https://provider.example/report");
    MockAsset token;
    Target target;
    bytes32[] ids;
    mapping(bytes32 => uint256) keys;
    uint256 nextKey = 1234;

    function setUp() public {
        vm.warp(1000);
        token = new MockAsset("USDC", "USDC", 6);
        Target.Limits memory lim = Target.Limits(10000, 10000, 5000, 5000, 5000);
        target = new Target(address(token), block.chainid, lim, lim, 3600, 86400, 86400);
        target.setOpeningsPaused(false);
        target.setSpendsPaused(false);
        token.mint(SPONSOR, 1000000);
        token.mint(CUSTOMER, 1000000);
        token.mint(PAYER, 1000000);
        vm.prank(SPONSOR);
        target.registerSponsor();
        vm.prank(SPONSOR);
        token.approve(address(target), type(uint256).max);
        vm.prank(CUSTOMER);
        target.registerSponsor();
        vm.prank(CUSTOMER);
        token.approve(address(target), type(uint256).max);
        vm.prank(PAYER);
        token.approve(address(target), type(uint256).max);
    }

    function open(uint256 reserve, address sponsor, uint256 key) internal returns (bytes32 id) {
        Target.OpenLineParams memory p = Target.OpenLineParams(
            vm.addr(key),
            reserve,
            5000,
            5000,
            uint64(block.timestamp + 86400),
            86400,
            SPONSOR,
            ENDPOINT,
            5000,
            5000,
            uint64(block.timestamp + 86400)
        );
        vm.prank(sponsor);
        id = target.openLine(p);
        ids.push(id);
        keys[id] = key;
    }

    function spend(bytes32 id, uint256 principal) internal returns (bytes32 digest) {
        Target.Line memory l = target.getLine(id);
        Target.SpendIntent memory i = Target.SpendIntent(
            l.agent,
            l.sponsor,
            id,
            l.epoch,
            target.currentTermsHash(id, SPONSOR),
            SPONSOR,
            ENDPOINT,
            principal,
            principal,
            block.timestamp + 3600,
            l.cumulativePrincipalPaid + 1,
            block.timestamp + 3600,
            address(0)
        );
        digest = target.hashSpendIntent(i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[id], digest);
        (bool paid,) = target.executeSpend(i, bytes.concat(r, s, bytes1(v)));
        require(paid, "spend failed");
    }

    function repay(bytes32 id, uint256 maximum) internal {
        bytes32 digest = target.currentDrawDigest(id);
        vm.prank(PAYER);
        target.repayForDraw(id, digest, maximum);
    }

    function fail(bytes memory data, bytes4 selector) internal {
        (bool ok, bytes memory reason) = address(target).call(data);
        require(!ok && reason.length >= 4 && bytes4(reason) == selector, "wrong rejection");
    }

    function assertAccounting() internal view {
        uint256 capacity;
        uint256 escrow;
        uint256 defaulted;
        for (uint256 j; j < ids.length; j++) {
            Target.Line memory l = target.getLine(ids[j]);
            escrow += l.availableReserve + l.recoveryAvailable;
            capacity += l.availableReserve;
            if (l.state == Target.LineState.DRAWN) capacity += l.principalOutstanding;
            if (l.state == Target.LineState.DEFAULTED) defaulted += l.principalOutstanding;
            if (l.state == Target.LineState.CLOSED) {
                require(
                    l.principalOutstanding == 0 && l.availableReserve == 0 && l.recoveryAvailable == 0, "closed money"
                );
            }
        }
        require(target.totalCommittedCapital() == capacity, "capacity drift");
        require(
            target.totalSponsorObligations() == escrow && token.balanceOf(address(target)) == escrow, "escrow drift"
        );
        require(target.totalDefaultedPrincipal() == defaulted, "defaulted debt drift");
        require(
            token.balanceOf(SPONSOR) + token.balanceOf(CUSTOMER) + token.balanceOf(PAYER) + token.balanceOf(CALLER)
                    + escrow == 3000000,
            "token conservation"
        );
    }

    function testDefaultRetiresPrincipalOnceAndAllowsAnotherSponsor() public {
        bytes32 id = open(10000, SPONSOR, 1234);
        spend(id, 5000);
        vm.warp(target.getLine(id).dueAt);
        vm.prank(SPONSOR);
        target.declareDefault(id);
        require(target.totalCommittedCapital() == 5000 && target.totalDefaultedPrincipal() == 5000, "not retired");
        vm.prank(SPONSOR);
        target.claimDefaulted(id);
        require(target.totalCommittedCapital() == 0 && target.getLine(id).principalOutstanding == 5000, "debt erased");
        vm.prank(SPONSOR);
        fail(abi.encodeCall(target.declareDefault, (id)), Target.InvalidState.selector);
        open(10000, CUSTOMER, 1235);
        assertAccounting();
    }

    function testExpiredFullDrawSettlesWithoutSponsorOrForgivingDebt() public {
        bytes32 id = open(5000, SPONSOR, 1234);
        bytes32 oldDraw = spend(id, 5000);
        vm.warp(uint256(target.getLine(id).expiry) + 1);
        target.setOpeningsPaused(true);
        target.setSpendsPaused(true);
        target.setSponsorAllowed(SPONSOR, false);
        vm.recordLogs();
        vm.prank(CALLER);
        target.settleExpiredLine(id);
        VmSettledRemediation.Log[] memory logs = vm.getRecordedLogs();
        bool matched;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("ExpiredLineSettled(bytes32,address,address,uint256,uint256)")) {
                (uint256 returned, uint256 debt) = abi.decode(logs[i].data, (uint256, uint256));
                matched = logs[i].emitter == address(target) && logs[i].topics[1] == id
                    && logs[i].topics[2] == bytes32(uint256(uint160(CALLER)))
                    && logs[i].topics[3] == bytes32(uint256(uint160(SPONSOR))) && returned == 0 && debt == 5000;
            }
        }
        require(matched, "settlement attribution");
        require(
            target.getLine(id).state == Target.LineState.DEFAULTED && target.currentDrawDigest(id) == oldDraw,
            "recovery lost"
        );
        require(target.totalCommittedCapital() == 0 && target.totalDefaultedPrincipal() == 5000, "capacity retained");
        fail(abi.encodeCall(target.settleExpiredLine, (id)), Target.InvalidState.selector);
        repay(id, 2000);
        vm.prank(CALLER);
        target.settleExpiredLine(id);
        require(target.getLine(id).principalOutstanding == 3000, "partial debt lost");
        repay(id, 5000);
        vm.prank(CALLER);
        target.settleExpiredLine(id);
        require(target.getLine(id).state == Target.LineState.CLOSED, "recovery not closed");
        require(token.balanceOf(CALLER) == 0, "caller received funds");
        assertAccounting();
    }

    function testTinyDrawExpiryReturnsReserveAndKeepsOldDrawRepayableAfterReopening() public {
        bytes32 old = open(10000, SPONSOR, 1234);
        bytes32 digest = spend(old, 1);
        vm.warp(uint256(target.getLine(old).expiry) + 1);
        vm.prank(CALLER);
        target.settleExpiredLine(old);
        require(target.totalCommittedCapital() == 0 && target.getLine(old).principalOutstanding == 1, "tiny draw stuck");
        bytes32 newer = open(10000, SPONSOR, 1234);
        spend(newer, 5000);
        vm.prank(PAYER);
        target.repayForDraw(old, digest, 5000);
        require(
            target.getLine(newer).principalOutstanding == 5000 && target.getLine(old).recoveryAvailable == 1,
            "wrong line paid"
        );
        vm.prank(CALLER);
        target.settleExpiredLine(old);
        assertAccounting();
    }

    function testUnclaimedDefaultReservePermissionlesslyReturnedAfterExpiry() public {
        bytes32 id = open(10000, SPONSOR, 1234);
        spend(id, 1);
        vm.warp(target.getLine(id).dueAt);
        vm.prank(SPONSOR);
        target.declareDefault(id);
        vm.warp(uint256(target.getLine(id).expiry) + 1);
        vm.prank(CALLER);
        target.settleExpiredLine(id);
        require(
            target.getLine(id).state == Target.LineState.DEFAULTED && target.getLine(id).principalOutstanding == 1
                && target.totalCommittedCapital() == 0,
            "reserve parked"
        );
        assertAccounting();
    }

    function testDustThenFullRepaymentCollectsOnlyRemainingDebtAndEmitsActualAmount() public {
        bytes32 id = open(10000, SPONSOR, 1234);
        spend(id, 5000);
        repay(id, 1);
        uint256 beforeBalance = token.balanceOf(PAYER);
        vm.recordLogs();
        repay(id, 5000);
        require(beforeBalance - token.balanceOf(PAYER) == 4999, "overcharged");
        VmSettledRemediation.Log[] memory logs = vm.getRecordedLogs();
        bool matched;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("DrawRepaid(bytes32,bytes32,address,uint256,uint256)")) {
                (uint256 actual, uint256 remaining) = abi.decode(logs[i].data, (uint256, uint256));
                matched = actual == 4999 && remaining == 0;
            }
        }
        require(matched, "actual repayment missing");
        bytes32 draw = target.currentDrawDigest(id);
        vm.prank(PAYER);
        fail(abi.encodeCall(target.repayForDraw, (id, draw, 5000)), Target.InvalidState.selector);
        assertAccounting();
    }

    function testExpiredOpenLineClosesAndExpiryBoundaryIsStrict() public {
        bytes32 id = open(10000, SPONSOR, 1234);
        vm.warp(target.getLine(id).expiry);
        fail(abi.encodeCall(target.settleExpiredLine, (id)), Target.TooEarly.selector);
        vm.warp(block.timestamp + 1);
        vm.prank(CALLER);
        target.settleExpiredLine(id);
        require(target.getLine(id).state == Target.LineState.CLOSED, "open not closed");
        fail(abi.encodeCall(target.settleExpiredLine, (id)), Target.InvalidState.selector);
        assertAccounting();
    }

    function testCannotShortenExpiryBelowExistingRepaymentPromise() public {
        bytes32 id = open(10000, SPONSOR, 1234);
        spend(id, 5000);
        uint64 tooEarly = uint64(target.getLine(id).dueAt - 1);
        vm.prank(SPONSOR);
        fail(
            abi.encodeCall(target.updateLineTerms, (id, 5000, 5000, tooEarly, uint64(86400))),
            Target.InvalidConfiguration.selector
        );
        fail(abi.encodeCall(target.settleExpiredLine, (id)), Target.TooEarly.selector);
        assertAccounting();
    }

    function testLatePartialRecoveryClaimsAndOtherClosureDoNotUnderflow() public {
        bytes32 id = open(5000, SPONSOR, 1234);
        spend(id, 5000);
        bytes32 other = open(5000, CUSTOMER, 1235);
        vm.warp(target.getLine(id).dueAt);
        vm.prank(SPONSOR);
        target.declareDefault(id);
        vm.prank(CUSTOMER);
        target.closeLine(other);
        repay(id, 2000);
        vm.prank(SPONSOR);
        target.claimDefaulted(id);
        assertAccounting();
        repay(id, 9000);
        vm.prank(SPONSOR);
        target.claimDefaulted(id);
        assertAccounting();
    }

    function testLateRecoveryCannotBlockAnotherLineAtFullCapacity() public {
        bytes32 old = open(5000, SPONSOR, 1234);
        spend(old, 5000);
        vm.warp(target.getLine(old).dueAt);
        vm.prank(SPONSOR);
        target.declareDefault(old);
        bytes32 live = open(10000, CUSTOMER, 1235);
        repay(old, 1);
        require(target.totalCommittedCapital() == 10000, "recovery consumed active headroom");
        require(target.getLine(old).recoveryAvailable == 1, "recovery not owed to sponsor");
        spend(live, 5000);
        assertAccounting();
    }

    function testRepeatedDefaultsDoNotAccumulatePermanentCapacity() public {
        for (uint256 i; i < 3; i++) {
            bytes32 id = open(10000, SPONSOR, 1234 + i);
            spend(id, 5000);
            vm.warp(target.getLine(id).dueAt);
            vm.prank(SPONSOR);
            target.declareDefault(id);
            vm.prank(SPONSOR);
            target.claimDefaulted(id);
            require(target.totalCommittedCapital() == 0, "default accumulated commitment");
            assertAccounting();
        }
        open(10000, CUSTOMER, 9999);
        assertAccounting();
    }

    function testFuzzMixedLifecycleAccounting(uint256 entropy) public {
        for (uint256 step; step < 40; step++) {
            entropy = uint256(keccak256(abi.encode(entropy, step)));
            uint256 action = entropy % 7;
            if (action == 0 || ids.length == 0) {
                if (target.totalCommittedCapital() + 5000 <= 10000) {
                    open(5000, step % 2 == 0 ? SPONSOR : CUSTOMER, nextKey++);
                }
            } else {
                bytes32 id = ids[(entropy >> 8) % ids.length];
                Target.Line memory l = target.getLine(id);
                if (
                    action == 1 && l.state == Target.LineState.OPEN && block.timestamp + 3600 <= l.expiry
                        && l.cumulativePrincipalPaid < 5000
                ) {
                    uint256 principal = 1 + (entropy >> 16) % (5000 - l.cumulativePrincipalPaid);
                    if (principal <= l.availableReserve) spend(id, principal);
                } else if (
                    action == 2 && (l.state == Target.LineState.DRAWN || l.state == Target.LineState.DEFAULTED)
                        && l.principalOutstanding > 0
                ) {
                    repay(id, 1 + (entropy >> 16) % 7000);
                } else if (action == 3 && l.state == Target.LineState.DRAWN && block.timestamp >= l.dueAt) {
                    vm.prank(l.sponsor);
                    target.declareDefault(id);
                } else if (
                    action == 4 && block.timestamp > l.expiry && l.state != Target.LineState.CLOSED
                        && (!target.expirySettled(id)
                            || l.availableReserve + l.recoveryAvailable > 0
                            || l.principalOutstanding == 0)
                ) {
                    vm.prank(CALLER);
                    target.settleExpiredLine(id);
                } else if (
                    action == 5 && l.state == Target.LineState.DEFAULTED && l.availableReserve + l.recoveryAvailable > 0
                ) {
                    vm.prank(l.sponsor);
                    target.claimDefaulted(id);
                } else if (action == 6) {
                    vm.warp(block.timestamp + 1 + (entropy >> 16) % 90000);
                }
            }
            assertAccounting();
        }
    }
}
