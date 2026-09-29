// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShadowFloatPublicTestnet} from "../src/ShadowFloatPublicTestnet.sol";
import {MockAsset} from "../src/MockAsset.sol";

interface VmRecovery {
    function chainId(uint256) external;
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}

// Deterministic contract signer; only the digest selected by the fixture is valid.
contract RecoveryTestAgent {
    bytes32 public expectedDigest;

    function approveDigest(bytes32 digest) external {
        expectedDigest = digest;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == expectedDigest ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract ShadowFloatPublicTestnetRecoveryTest {
    VmRecovery constant vm = VmRecovery(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockAsset token;
    ShadowFloatPublicTestnet target;
    RecoveryTestAgent agent;
    address constant SPONSOR = address(0xAA01);
    address constant PROVIDER = address(0xCC01);
    address constant REPAYER = address(0xDD01);

    function setUp() public {
        vm.chainId(5042002);
        token = new MockAsset("USDC", "USDC", 6);
        ShadowFloatPublicTestnet.Limits memory caps = ShadowFloatPublicTestnet.Limits(25e6, 5e6, 5e6, 1e6, 2e6);
        target = new ShadowFloatPublicTestnet(address(token), caps, caps, 60, 7 days, 1 days);
        agent = new RecoveryTestAgent();
        token.mint(SPONSOR, 10e6);
        token.mint(REPAYER, 1e6);
        vm.prank(SPONSOR);
        target.registerSponsor();
        vm.prank(SPONSOR);
        token.approve(address(target), 10e6);
        vm.prank(REPAYER);
        token.approve(address(target), 1e6);
    }

    function _open() internal returns (bytes32) {
        ShadowFloatPublicTestnet.OpenLineParams memory p = ShadowFloatPublicTestnet.OpenLineParams({
            agent: address(agent),
            reserve: 1e6,
            lineSpendCap: 1e6,
            dailySpendCap: 1e6,
            lineExpiry: uint64(block.timestamp + 2 days),
            maximumRepaymentWindow: 1 hours,
            provider: PROVIDER,
            endpointHash: keccak256("service"),
            providerPerSpendCap: 1e6,
            providerDailyCap: 1e6,
            providerExpiry: uint64(block.timestamp + 2 days)
        });
        vm.prank(SPONSOR);
        return target.openLine(p);
    }

    function _intent(bytes32 id, uint256 amount, uint256 nonce)
        internal
        returns (ShadowFloatPublicTestnet.SpendIntent memory intent)
    {
        intent = ShadowFloatPublicTestnet.SpendIntent({
            agent: address(agent),
            sponsor: SPONSOR,
            lineId: id,
            lineEpoch: target.getLine(id).epoch,
            termsHash: target.currentTermsHash(id, PROVIDER),
            provider: PROVIDER,
            endpointHash: keccak256("service"),
            principal: amount,
            maximumTotalDebt: amount,
            dueAt: block.timestamp + 120,
            nonce: nonce,
            signatureExpiry: block.timestamp + 300,
            executor: address(0)
        });
        agent.approveDigest(target.hashSpendIntent(intent));
    }

    function _draw(bytes32 id, uint256 amount, uint256 nonce) internal {
        ShadowFloatPublicTestnet.SpendIntent memory intent = _intent(id, amount, nonce);
        (bool paid,) = target.executeSpend(intent, "");
        require(paid, "purchase blocked");
    }

    function _accounting(bytes32 id, uint256 reserve, uint256 debt, uint256 recovery, uint256 committed) internal view {
        ShadowFloatPublicTestnet.Line memory line = target.getLine(id);
        require(line.availableReserve == reserve, "reserve mismatch");
        require(line.principalOutstanding == debt, "debt mismatch");
        require(line.recoveryAvailable == recovery, "recovery mismatch");
        require(target.totalCommittedCapital() == committed, "committed mismatch");
        require(target.totalSponsorObligations() == reserve + recovery, "obligation mismatch");
        require(token.balanceOf(address(target)) == reserve + recovery, "token balance mismatch");
    }

    function testThirdPartyRepaymentRestoresReserveAndAllowsDistinctRedraw() public {
        bytes32 id = _open();
        _draw(id, 500_000, 1);
        _accounting(id, 500_000, 500_000, 0, 1e6);
        vm.prank(REPAYER);
        target.repay(id, 500_000);
        _accounting(id, 1e6, 0, 0, 1e6);
        require(token.balanceOf(REPAYER) == 500_000, "wrong payer debit");
        require(target.getLine(id).state == ShadowFloatPublicTestnet.LineState.OPEN, "not reopened");
        // No clock advance: sequential valid draws can occur in the same block after repayment.
        _draw(id, 200_000, 2);
        _accounting(id, 800_000, 200_000, 0, 1e6);
        require(target.getLine(id).cumulativePrincipalPaid == 700_000, "spend limit reset");
        require(token.balanceOf(PROVIDER) == 700_000, "wrong provider payments");
    }

    function testReplayedPurchaseCannotPayAgainAfterRepayment() public {
        bytes32 id = _open();
        ShadowFloatPublicTestnet.SpendIntent memory intent = _intent(id, 500_000, 1);
        (bool paid,) = target.executeSpend(intent, "");
        require(paid, "purchase blocked");
        vm.prank(REPAYER);
        target.repay(id, 500_000);
        vm.expectRevert(ShadowFloatPublicTestnet.NonceUnavailable.selector);
        target.executeSpend(intent, "");
        require(token.balanceOf(PROVIDER) == 500_000, "duplicate payment");
        _accounting(id, 1e6, 0, 0, 1e6);
        vm.prank(SPONSOR);
        target.closeLine(id);
        _accounting(id, 0, 0, 0, 0);
        require(target.getLine(id).state == ShadowFloatPublicTestnet.LineState.CLOSED, "not closed");
        require(token.balanceOf(SPONSOR) == 10e6, "incorrect reclaim");
    }

    function testPartialDefaultRecoveryThenLaterRepaymentCanBothBeClaimed() public {
        bytes32 id = _open();
        _draw(id, 500_000, 1);
        vm.warp(target.getLine(id).dueAt);
        vm.prank(SPONSOR);
        target.declareDefault(id);
        vm.prank(REPAYER);
        target.repay(id, 300_000);
        _accounting(id, 500_000, 200_000, 300_000, 1e6);
        vm.prank(SPONSOR);
        target.claimDefaulted(id);
        _accounting(id, 0, 200_000, 0, 200_000);
        require(token.balanceOf(SPONSOR) == 9_800_000, "wrong first claim");
        vm.prank(REPAYER);
        target.repay(id, 200_000);
        _accounting(id, 0, 0, 200_000, 200_000);
        vm.prank(SPONSOR);
        target.claimDefaulted(id);
        _accounting(id, 0, 0, 0, 0);
        require(token.balanceOf(SPONSOR) == 10e6, "missing later recovery");
        require(target.getLine(id).state == ShadowFloatPublicTestnet.LineState.DEFAULTED, "default reopened");
        vm.expectRevert(ShadowFloatPublicTestnet.InvalidAmount.selector);
        vm.prank(SPONSOR);
        target.claimDefaulted(id);
    }

    function testRestoringReducedCapStillWaitsFullGovernanceDelay() public {
        target.reduceCap(ShadowFloatPublicTestnet.CapKind.PER_SPEND, 1);
        target.proposeCapIncrease(ShadowFloatPublicTestnet.CapKind.PER_SPEND, 1e6);
        uint256 readyAt = block.timestamp + target.governanceDelay();
        vm.expectRevert(ShadowFloatPublicTestnet.CapNotReady.selector);
        target.activateCapIncrease(ShadowFloatPublicTestnet.CapKind.PER_SPEND);
        vm.warp(readyAt - 1);
        vm.expectRevert(ShadowFloatPublicTestnet.CapNotReady.selector);
        target.activateCapIncrease(ShadowFloatPublicTestnet.CapKind.PER_SPEND);
        vm.warp(readyAt);
        target.activateCapIncrease(ShadowFloatPublicTestnet.CapKind.PER_SPEND);
        (,,, uint256 restored,) = target.effectiveLimits();
        require(restored == 1e6, "cap not restored");
    }
}
