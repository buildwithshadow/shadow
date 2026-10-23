// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShadowFloatMainnetPublicSettled} from "../src/ShadowFloatMainnetPublicSettled.sol";
import {AdversarialUSDC} from "./mocks/AdversarialUSDC.sol";

interface VmSettledToken {
    function warp(uint256) external;
    function addr(uint256 privateKey) external returns (address);
    function prank(address caller) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract ShadowFloatMainnetPublicSettledTokenSafetyTest {
    VmSettledToken private constant vm = VmSettledToken(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant USDC = 1e6;
    uint256 private constant SPONSOR_PK = 0x5100;
    uint256 private constant AGENT_PK = 0xA11CE;
    address private constant PROVIDER = address(0xBEEF);
    bytes32 private constant ENDPOINT = keccak256("x402://adversarial-token");

    AdversarialUSDC private token;
    ShadowFloatMainnetPublicSettled private float;
    address private sponsor;
    address private agent;

    function setUp() public {
        sponsor = vm.addr(SPONSOR_PK);
        agent = vm.addr(AGENT_PK);
        token = new AdversarialUSDC();
        ShadowFloatMainnetPublicSettled.Limits memory limits = ShadowFloatMainnetPublicSettled.Limits({
            protocolReserve: 10 * USDC,
            lineReserve: 5 * USDC,
            lineSpend: 5 * USDC,
            perSpend: 2 * USDC,
            dailySpend: 5 * USDC
        });
        float = new ShadowFloatMainnetPublicSettled(
            address(token), block.chainid, limits, limits, uint64(1 hours), uint64(7 days), uint64(1 days)
        );
        float.setOpeningsPaused(false);
        float.setSpendsPaused(false);
        float.setSponsorAllowed(sponsor, true);
        token.mint(sponsor, 10 * USDC);
        token.mint(agent, 10 * USDC);
        vm.prank(sponsor);
        token.approve(address(float), type(uint256).max);
        vm.prank(agent);
        token.approve(address(float), type(uint256).max);
    }

    function _open() private returns (bytes32 lineId) {
        ShadowFloatMainnetPublicSettled.OpenLineParams memory params = ShadowFloatMainnetPublicSettled.OpenLineParams({
            agent: agent,
            reserve: 5 * USDC,
            lineSpendCap: 5 * USDC,
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
        lineId = float.openLine(params);
    }

    function _intent(bytes32 lineId, uint256 nonce)
        private
        view
        returns (ShadowFloatMainnetPublicSettled.SpendIntent memory)
    {
        ShadowFloatMainnetPublicSettled.Line memory line = float.getLine(lineId);
        return ShadowFloatMainnetPublicSettled.SpendIntent({
            agent: agent,
            sponsor: sponsor,
            lineId: lineId,
            lineEpoch: line.epoch,
            termsHash: float.currentTermsHash(lineId, PROVIDER),
            provider: PROVIDER,
            endpointHash: ENDPOINT,
            principal: 1 * USDC,
            maximumTotalDebt: 1 * USDC,
            dueAt: block.timestamp + 1 days,
            nonce: nonce,
            signatureExpiry: block.timestamp + 1 hours,
            executor: address(0)
        });
    }

    function _sign(ShadowFloatMainnetPublicSettled.SpendIntent memory intent) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, float.hashSpendIntent(intent));
        return bytes.concat(r, s, bytes1(v));
    }

    function testInboundFalseMalformedRevertAndNonExactAreAtomic() public {
        uint8[4] memory modes = [token.FALSE_RETURN(), token.MALFORMED_RETURN(), token.REVERT_CALL(), token.NON_EXACT()];
        for (uint256 i; i < modes.length; ++i) {
            token.configure(modes[i], address(0), "");
            ShadowFloatMainnetPublicSettled.OpenLineParams memory params = ShadowFloatMainnetPublicSettled.OpenLineParams({
                agent: agent,
                reserve: 5 * USDC,
                lineSpendCap: 5 * USDC,
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
            (bool ok,) =
                address(float).call(abi.encodeWithSelector(ShadowFloatMainnetPublicSettled.openLine.selector, params));
            require(!ok, "unsafe inbound token behavior accepted");
            require(float.totalCommittedCapital() == 0, "failed funding committed capital");
            require(float.totalSponsorObligations() == 0, "failed funding created obligation");
        }
    }

    function testOutgoingFailuresLeaveNonceDebtAndFundsUnchanged() public {
        bytes32 lineId = _open();
        ShadowFloatMainnetPublicSettled.SpendIntent memory intent = _intent(lineId, 1);
        bytes memory signature = _sign(intent);
        uint8[4] memory modes = [token.FALSE_RETURN(), token.MALFORMED_RETURN(), token.REVERT_CALL(), token.NON_EXACT()];
        for (uint256 i; i < modes.length; ++i) {
            token.configure(modes[i], address(0), "");
            (bool ok,) = address(float)
                .call(abi.encodeWithSelector(ShadowFloatMainnetPublicSettled.executeSpend.selector, intent, signature));
            require(!ok, "unsafe outgoing token behavior accepted");
            require(!float.nonceUsed(lineId, intent.nonce), "failed transfer consumed nonce");
            ShadowFloatMainnetPublicSettled.Line memory line = float.getLine(lineId);
            require(line.principalOutstanding == 0, "failed transfer created debt");
            require(line.availableReserve == 5 * USDC, "failed transfer reduced reserve");
            require(token.balanceOf(PROVIDER) == 0, "failed transfer paid provider");
        }
    }

    function testTokenCallbackCannotReenterButOuterPaymentCompletesOnce() public {
        bytes32 lineId = _open();
        ShadowFloatMainnetPublicSettled.SpendIntent memory intent = _intent(lineId, 2);
        bytes memory signature = _sign(intent);
        bytes memory nested =
            abi.encodeWithSelector(ShadowFloatMainnetPublicSettled.executeSpend.selector, intent, signature);
        token.configure(token.REENTER(), address(float), nested);
        (bool paid,) = float.executeSpend(intent, signature);
        require(paid, "outer payment failed");
        require(token.balanceOf(PROVIDER) == 1 * USDC, "provider paid more than once");
        require(float.getLine(lineId).principalOutstanding == 1 * USDC, "debt not exact");
    }

    function testTokenCallbackCannotCancelAgentNonceDuringFunding() public {
        uint64 epoch = 1;
        bytes32 lineId = keccak256(abi.encode(block.chainid, address(float), sponsor, address(token), epoch));
        uint256 nonce = 77;
        bytes memory nested =
            abi.encodeWithSelector(ShadowFloatMainnetPublicSettled.cancelNonce.selector, lineId, nonce);
        token.configure(token.REENTER(), address(float), nested);

        ShadowFloatMainnetPublicSettled.OpenLineParams memory params = ShadowFloatMainnetPublicSettled.OpenLineParams({
            agent: address(token),
            reserve: 5 * USDC,
            lineSpendCap: 5 * USDC,
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
        bytes32 opened = float.openLine(params);
        require(opened == lineId, "unexpected precomputed line ID");
        require(!float.nonceCancelled(lineId, nonce), "callback cancelled agent nonce");
        require(float.totalCommittedCapital() == 5 * USDC, "outer funding did not complete");
    }

    function testExpiredCloseTokenFailuresPreserveReserveAndPermitRetry() public {
        bytes32 lineId = _open();
        vm.warp(uint256(float.getLine(lineId).expiry) + 1);
        uint256 sponsorBefore = token.balanceOf(sponsor);
        uint8[4] memory modes = [token.FALSE_RETURN(), token.MALFORMED_RETURN(), token.REVERT_CALL(), token.NON_EXACT()];
        for (uint256 i; i < modes.length; ++i) {
            token.configure(modes[i], address(0), "");
            (bool ok,) = address(float).call(abi.encodeCall(float.closeExpiredLine, (lineId)));
            require(!ok, "unsafe expired transfer accepted");
            require(
                float.getLine(lineId).state == ShadowFloatMainnetPublicSettled.LineState.OPEN,
                "failed close changed state"
            );
            require(float.getLine(lineId).availableReserve == 5 * USDC, "failed close changed reserve");
            require(
                float.totalCommittedCapital() == 5 * USDC && float.totalSponsorObligations() == 5 * USDC,
                "failed close changed accounting"
            );
            require(token.balanceOf(sponsor) == sponsorBefore, "failed close changed sponsor balance");
        }
        token.configure(token.NORMAL(), address(0), "");
        float.closeExpiredLine(lineId);
        require(token.balanceOf(sponsor) == sponsorBefore + 5 * USDC, "retry failed to return exact reserve");
        require(float.totalCommittedCapital() == 0 && float.totalSponsorObligations() == 0, "retry left obligations");
    }

    function testExpiredCloseRejectsCallbackReentryAndReturnsOnce() public {
        bytes32 lineId = _open();
        vm.warp(uint256(float.getLine(lineId).expiry) + 1);
        uint256 sponsorBefore = token.balanceOf(sponsor);
        token.configure(token.REENTER(), address(float), abi.encodeCall(float.closeExpiredLine, (lineId)));
        float.closeExpiredLine(lineId);
        require(token.balanceOf(sponsor) == sponsorBefore + 5 * USDC, "not an exact single return");
        require(float.getLine(lineId).state == ShadowFloatMainnetPublicSettled.LineState.CLOSED, "outer close failed");
        require(float.totalCommittedCapital() == 0 && float.totalSponsorObligations() == 0, "outer close left capacity");
    }

    function testNonExactRepaymentIsAtomicEvenAfterMaturity() public {
        bytes32 lineId = _open();
        ShadowFloatMainnetPublicSettled.SpendIntent memory intent = _intent(lineId, 3);
        float.executeSpend(intent, _sign(intent));
        token.configure(token.NON_EXACT(), address(0), "");
        bytes32 draw = float.currentDrawDigest(lineId);
        vm.prank(agent);
        (bool ok, bytes memory reason) = address(float)
            .call(abi.encodeWithSelector(ShadowFloatMainnetPublicSettled.repayForDraw.selector, lineId, draw, 1 * USDC));
        require(
            !ok && bytes4(reason) == ShadowFloatMainnetPublicSettled.NonExactTransfer.selector,
            "non-exact repayment accepted"
        );
        require(float.getLine(lineId).principalOutstanding == 1 * USDC, "failed repayment changed debt");
    }

    function testExpiredDrawSettlementFailuresRollBackDefaultAndAllCounters() public {
        bytes32 id = _open();
        ShadowFloatMainnetPublicSettled.SpendIntent memory intent = _intent(id, 4);
        float.executeSpend(intent, _sign(intent));
        vm.warp(uint256(float.getLine(id).expiry) + 1);
        uint8[4] memory modes = [token.FALSE_RETURN(), token.MALFORMED_RETURN(), token.REVERT_CALL(), token.NON_EXACT()];
        for (uint256 i; i < modes.length; ++i) {
            token.configure(modes[i], address(0), "");
            (bool ok,) = address(float).call(abi.encodeCall(float.settleExpiredLine, (id)));
            require(!ok, "invalid settlement transfer accepted");
            require(
                float.getLine(id).state == ShadowFloatMainnetPublicSettled.LineState.DRAWN,
                "failed transfer defaulted line"
            );
            require(
                float.totalCommittedCapital() == 5 * USDC && float.totalDefaultedPrincipal() == 0,
                "failed transfer retired debt"
            );
            require(
                float.totalSponsorObligations() == 4 * USDC && !float.expirySettled(id),
                "failed transfer changed obligations"
            );
        }
        token.configure(token.NORMAL(), address(0), "");
        float.settleExpiredLine(id);
        require(
            float.getLine(id).principalOutstanding == 1 * USDC && float.totalCommittedCapital() == 0,
            "settlement lost debt or retained capacity"
        );
    }

    function testSettlementAndDefaultRecoveryRejectCrossFunctionReentry() public {
        bytes32 id = _open();
        ShadowFloatMainnetPublicSettled.SpendIntent memory intent = _intent(id, 5);
        float.executeSpend(intent, _sign(intent));
        vm.warp(uint256(float.getLine(id).expiry) + 1);
        token.configure(token.REENTER(), address(float), abi.encodeCall(float.settleExpiredLine, (id)));
        float.settleExpiredLine(id);
        require(
            float.totalCommittedCapital() == 0 && float.totalDefaultedPrincipal() == 1 * USDC, "settlement duplicated"
        );
        bytes32 draw = float.currentDrawDigest(id);
        token.configure(token.REENTER(), address(float), abi.encodeCall(float.settleExpiredLine, (id)));
        vm.prank(agent);
        float.repayForDraw(id, draw, 2 * USDC);
        require(
            float.totalDefaultedPrincipal() == 0 && float.getLine(id).recoveryAvailable == 1 * USDC,
            "recovery duplicated"
        );
        require(
            float.totalCommittedCapital() == 0 && float.totalSponsorObligations() == 1 * USDC,
            "recovery is active capital"
        );
        float.settleExpiredLine(id);
        require(
            float.getLine(id).state == ShadowFloatMainnetPublicSettled.LineState.CLOSED, "final recovery not closed"
        );
        require(float.totalSponsorObligations() == 0, "recovery trapped");
    }
}
