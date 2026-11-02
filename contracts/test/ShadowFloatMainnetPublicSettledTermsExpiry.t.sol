// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloatMainnetPublicSettled as Float} from "../src/ShadowFloatMainnetPublicSettled.sol";

interface VmTermsExpiry {
    function addr(uint256 privateKey) external returns (address);
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function expectEmit(bool, bool, bool, bool, address) external;
}

/// @notice Regression coverage for the interaction of updateLineTerms, setProviderPolicy, termsVersion
/// invalidation of signed intents, expired-line settlement and draw-bound repayment/recovery.
contract ShadowFloatMainnetPublicSettledTermsExpiryTest {
    VmTermsExpiry private constant vm = VmTermsExpiry(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant USDC = 1e6;
    uint256 private constant SPONSOR_PK = 0x5100;
    uint256 private constant AGENT_PK = 0xA11CE;
    address private constant PROVIDER = address(0xBEEF);
    address private constant OTHER_PROVIDER = address(0xCAFE);
    address private constant STRANGER = address(0xCA11);
    bytes32 private constant ENDPOINT = keccak256("x402://mainnet/provider.v1");

    event LineTermsUpdated(bytes32 indexed lineId, uint64 indexed termsVersion);

    MockAsset private usdc;
    Float private float;
    address private sponsor;
    address private agent;

    function setUp() public {
        sponsor = vm.addr(SPONSOR_PK);
        agent = vm.addr(AGENT_PK);
        usdc = new MockAsset("Mock USDC", "USDC", 6);
        Float.Limits memory maxima = Float.Limits({
            protocolReserve: 100 * USDC,
            lineReserve: 10 * USDC,
            lineSpend: 20 * USDC,
            perSpend: 5 * USDC,
            dailySpend: 10 * USDC
        });
        Float.Limits memory initial = Float.Limits({
            protocolReserve: 50 * USDC,
            lineReserve: 5 * USDC,
            lineSpend: 10 * USDC,
            perSpend: 2 * USDC,
            dailySpend: 5 * USDC
        });
        float = new Float(address(usdc), block.chainid, maxima, initial, uint64(1 hours), uint64(7 days), uint64(2 days));
        float.setOpeningsPaused(false);
        float.setSpendsPaused(false);
        float.setSponsorAllowed(sponsor, true);
        usdc.mint(sponsor, 100 * USDC);
        usdc.mint(agent, 100 * USDC);
        vm.prank(sponsor);
        usdc.approve(address(float), type(uint256).max);
        vm.prank(agent);
        usdc.approve(address(float), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // 1. termsVersion alone invalidates queued signatures.
    // ---------------------------------------------------------------------

    /// updateLineTerms restating identical values, and setProviderPolicy for an unrelated provider, each bump the
    /// line-wide termsVersion. A signature made before either call must stop working even though every term that
    /// the signer reviewed for PROVIDER is unchanged.
    function testTermsVersionAloneInvalidatesQueuedIntents() public {
        bytes32 id = _open();
        Float.Line memory opened = float.getLine(id);
        (bytes32 endpointBefore,,, bool activeBefore, uint256 perBefore, uint256 dailyBefore,) =
            float.providerPolicies(id, PROVIDER);
        bytes32 hashV1 = float.currentTermsHash(id, PROVIDER);
        _assertEq(opened.termsVersion, 1, "initial version");

        Float.SpendIntent memory q1 = _intent(id, 1 * USDC, 1);
        bytes memory s1 = _sign(q1);

        // Restate the exact same line terms.
        vm.expectEmit(true, true, false, false, address(float));
        emit LineTermsUpdated(id, 2);
        vm.prank(sponsor);
        float.updateLineTerms(id, opened.lineSpendCap, opened.dailySpendCap, opened.expiry, opened.maximumRepaymentWindow);

        Float.Line memory restated = float.getLine(id);
        _assertEq(restated.termsVersion, 2, "update did not bump version");
        _assertEq(restated.lineSpendCap, opened.lineSpendCap, "cap changed");
        _assertEq(restated.dailySpendCap, opened.dailySpendCap, "daily cap changed");
        _assertEq(restated.expiry, opened.expiry, "expiry changed");
        _assertEq(restated.maximumRepaymentWindow, opened.maximumRepaymentWindow, "window changed");
        require(float.currentTermsHash(id, PROVIDER) != hashV1, "hash ignored termsVersion");
        _assertStale(q1, s1);

        // An edit to a different provider still invalidates PROVIDER intents because the version is line-wide.
        Float.SpendIntent memory q2 = _intent(id, 1 * USDC, 2);
        bytes memory s2 = _sign(q2);
        vm.prank(sponsor);
        float.setProviderPolicy(
            id, OTHER_PROVIDER, keccak256("x402://other"), 1 * USDC, 2 * USDC, uint64(block.timestamp + 6 days), true
        );
        _assertEq(float.getLine(id).termsVersion, 3, "policy edit did not bump version");
        (bytes32 endpointAfter,,, bool activeAfter, uint256 perAfter, uint256 dailyAfter,) =
            float.providerPolicies(id, PROVIDER);
        require(endpointAfter == endpointBefore && activeAfter == activeBefore, "provider policy changed");
        _assertEq(perAfter, perBefore, "provider per-spend changed");
        _assertEq(dailyAfter, dailyBefore, "provider daily changed");
        _assertStale(q2, s2);

        // Intents signed against the current version still execute.
        Float.SpendIntent memory q3 = _intent(id, 1 * USDC, 3);
        (bool paid,) = float.executeSpend(q3, _sign(q3));
        _assertTrue(paid, "current-version intent rejected");
    }

    // ---------------------------------------------------------------------
    // 2. Sponsor edits during an outstanding draw cannot strand repayment.
    // ---------------------------------------------------------------------

    function testTermsEditsDuringOutstandingDrawDoNotStrandRepayment() public {
        bytes32 id = _open();
        Float.SpendIntent memory queued = _intent(id, 1 * USDC, 2);
        bytes memory queuedSig = _sign(queued);
        Float.SpendIntent memory first = _intent(id, 1 * USDC, 1);
        (bool paid,) = float.executeSpend(first, _sign(first));
        _assertTrue(paid, "draw failed");
        bytes32 draw = float.currentDrawDigest(id);
        uint256 dueAt = float.getLine(id).dueAt;

        // Sponsor disables the provider and tightens the line while the draw is outstanding.
        vm.prank(sponsor);
        float.setProviderPolicy(id, PROVIDER, ENDPOINT, 0, 0, 0, false);
        vm.prank(sponsor);
        float.updateLineTerms(id, 1 * USDC, 1 * USDC, uint64(dueAt + 1 days), uint64(1 hours));
        Float.Line memory edited = float.getLine(id);
        _assertEq(edited.termsVersion, 3, "edits did not bump version");
        require(float.currentDrawDigest(id) == draw, "terms edit changed draw identity");

        // The pre-edit draw digest stays repayable: partial first, then an over-sized upper bound.
        vm.prank(agent);
        float.repayForDraw(id, draw, 400_000);
        Float.Line memory mid = float.getLine(id);
        require(mid.state == Float.LineState.DRAWN, "partial repayment changed state");
        _assertEq(mid.principalOutstanding, 600_000, "partial debt wrong");
        _assertEq(mid.dueAt, dueAt, "partial repayment moved dueAt");

        uint256 agentBefore = usdc.balanceOf(agent);
        vm.prank(agent);
        float.repayForDraw(id, draw, 5 * USDC);
        _assertEq(agentBefore - usdc.balanceOf(agent), 600_000, "repayment pulled more than the debt");
        Float.Line memory repaid = float.getLine(id);
        require(repaid.state == Float.LineState.OPEN, "line did not reopen");
        _assertEq(repaid.availableReserve, 5 * USDC, "reserve not restored");
        _assertEq(repaid.dueAt, 0, "dueAt retained");
        require(float.currentDrawDigest(id) == draw, "draw identity lost");

        // The queued, pre-edit authorization remains unusable and untouched.
        _assertStale(queued, queuedSig);

        // The edits did not trap the reserve: the sponsor recovers it in full.
        vm.prank(sponsor);
        float.closeLine(id);
        _assertEq(usdc.balanceOf(sponsor), 100 * USDC, "sponsor reserve trapped");
        _assertEq(usdc.balanceOf(PROVIDER), 1 * USDC, "provider payment changed");
        _assertEq(usdc.balanceOf(address(float)), 0, "tokens left in contract");
        _assertEq(float.totalSponsorObligations(), 0, "obligation left");
        _assertEq(float.totalCommittedCapital(), 0, "capital left");
    }

    // ---------------------------------------------------------------------
    // 3. Expiry shortened to exactly dueAt, strict settlement boundary, recovery.
    // ---------------------------------------------------------------------

    function testExpiryShortenedToExactDueAtSettlesStrictlyThenRecoversByOldDraw() public {
        bytes32 id = _open();
        Float.SpendIntent memory first = _intent(id, 1 * USDC, 1);
        (bool paid,) = float.executeSpend(first, _sign(first));
        _assertTrue(paid, "draw failed");
        bytes32 draw = float.currentDrawDigest(id);
        uint256 dueAt = float.getLine(id).dueAt;

        vm.prank(agent);
        float.repayForDraw(id, draw, 400_000);

        // Exact boundary: lineExpiry == dueAt is accepted on a DRAWN line.
        vm.prank(sponsor);
        float.updateLineTerms(id, 10 * USDC, 5 * USDC, uint64(dueAt), uint64(7 days));
        _assertEq(float.getLine(id).expiry, dueAt, "expiry not shortened to dueAt");

        // Expiry is strict: nothing can settle at dueAt itself.
        vm.warp(dueAt);
        _expectRevert(STRANGER, abi.encodeCall(float.settleExpiredLine, (id)), Float.TooEarly.selector);
        require(float.getLine(id).state == Float.LineState.DRAWN, "settled at expiry");

        // One second later anyone may retire the line; unpaid debt is kept, never forgiven.
        vm.warp(dueAt + 1);
        vm.prank(STRANGER);
        float.settleExpiredLine(id);
        Float.Line memory settled = float.getLine(id);
        require(settled.state == Float.LineState.DEFAULTED, "line not defaulted");
        _assertEq(settled.principalOutstanding, 600_000, "debt changed");
        _assertEq(settled.availableReserve, 0, "reserve retained");
        _assertEq(float.totalCommittedCapital(), 0, "capacity retained");
        _assertEq(float.totalDefaultedPrincipal(), 600_000, "defaulted principal wrong");
        _assertEq(usdc.balanceOf(sponsor), 100 * USDC - 5 * USDC + 4_400_000, "sponsor reserve not returned");
        _assertEq(usdc.balanceOf(STRANGER), 0, "caller received funds");
        require(float.currentDrawDigest(id) == draw, "draw identity lost");

        // A defaulted/settled line can no longer be revived by sponsor edits.
        _expectRevert(
            sponsor,
            abi.encodeCall(float.updateLineTerms, (id, 10 * USDC, 5 * USDC, uint64(dueAt + 1 days), uint64(7 days))),
            Float.InvalidState.selector
        );
        _expectRevert(
            sponsor,
            abi.encodeCall(
                float.setProviderPolicy, (id, PROVIDER, ENDPOINT, 1 * USDC, 1 * USDC, uint64(dueAt + 1 days), true)
            ),
            Float.InvalidState.selector
        );

        // Late repayment against the original draw becomes sponsor recovery and is returned on re-settlement.
        vm.prank(agent);
        float.repayForDraw(id, draw, 200_000);
        _assertEq(float.getLine(id).recoveryAvailable, 200_000, "recovery not escrowed");
        vm.prank(STRANGER);
        float.settleExpiredLine(id);
        _assertEq(usdc.balanceOf(sponsor), 100 * USDC - 5 * USDC + 4_400_000 + 200_000, "recovery not returned");
        _expectRevert(STRANGER, abi.encodeCall(float.settleExpiredLine, (id)), Float.InvalidState.selector);

        vm.prank(agent);
        float.repayForDraw(id, draw, 5 * USDC);
        vm.prank(STRANGER);
        float.settleExpiredLine(id);
        require(float.getLine(id).state == Float.LineState.CLOSED, "recovered line not closed");
        _assertEq(usdc.balanceOf(sponsor), 100 * USDC, "sponsor not made whole");
        _assertEq(usdc.balanceOf(address(float)), 0, "tokens left in contract");
        _assertEq(float.totalSponsorObligations(), 0, "obligation left");
        _assertEq(float.totalCommittedCapital(), 0, "capital left");
        _assertEq(float.totalDefaultedPrincipal(), 0, "defaulted principal left");

        // CLOSED is terminal for edits and for stale-draw repayment.
        _expectRevert(
            sponsor,
            abi.encodeCall(float.updateLineTerms, (id, 10 * USDC, 5 * USDC, uint64(dueAt + 1 days), uint64(7 days))),
            Float.InvalidState.selector
        );
        _expectRevert(agent, abi.encodeCall(float.repayForDraw, (id, draw, 1)), Float.InvalidState.selector);
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    function _open() private returns (bytes32 lineId) {
        Float.OpenLineParams memory params = Float.OpenLineParams({
            agent: agent,
            reserve: 5 * USDC,
            lineSpendCap: 10 * USDC,
            dailySpendCap: 5 * USDC,
            lineExpiry: uint64(block.timestamp + 6 days),
            maximumRepaymentWindow: uint64(7 days),
            provider: PROVIDER,
            endpointHash: ENDPOINT,
            providerPerSpendCap: 2 * USDC,
            providerDailyCap: 5 * USDC,
            providerExpiry: uint64(block.timestamp + 6 days)
        });
        vm.prank(sponsor);
        return float.openLine(params);
    }

    function _intent(bytes32 lineId, uint256 principal, uint256 nonce) private view returns (Float.SpendIntent memory) {
        Float.Line memory line = float.getLine(lineId);
        return Float.SpendIntent({
            agent: agent,
            sponsor: sponsor,
            lineId: lineId,
            lineEpoch: line.epoch,
            termsHash: float.currentTermsHash(lineId, PROVIDER),
            provider: PROVIDER,
            endpointHash: ENDPOINT,
            principal: principal,
            maximumTotalDebt: principal,
            dueAt: block.timestamp + 1 days,
            nonce: nonce,
            signatureExpiry: block.timestamp + 1 hours,
            executor: address(0)
        });
    }

    function _sign(Float.SpendIntent memory intent) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, float.hashSpendIntent(intent));
        return bytes.concat(r, s, bytes1(v));
    }

    function _assertStale(Float.SpendIntent memory intent, bytes memory signature) private {
        (bool ok, bytes memory reason) =
            address(float).call(abi.encodeCall(float.executeSpend, (intent, signature)));
        require(!ok && reason.length >= 4 && bytes4(reason) == Float.StaleTerms.selector, "intent not stale");
        require(!float.nonceUsed(intent.lineId, intent.nonce), "stale intent consumed nonce");
        require(float.receiptStatus(float.hashSpendIntent(intent)) == 0, "stale intent wrote receipt");
    }

    function _expectRevert(address caller, bytes memory data, bytes4 selector) private {
        vm.prank(caller);
        (bool ok, bytes memory reason) = address(float).call(data);
        require(!ok && reason.length >= 4 && bytes4(reason) == selector, "wrong rejection");
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory message) private pure {
        require(actual == expected, message);
    }
}
