// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloatMainnet} from "../src/ShadowFloatMainnet.sol";

interface VmPilotLifecycle {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract PilotSmartAccount {
    bytes4 private constant MAGIC = 0x1626ba7e;

    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (bytes32 r, bytes32 s, uint8 v) = abi.decode(signature, (bytes32, bytes32, uint8));
        return ecrecover(digest, v, r, s) == signer ? MAGIC : bytes4(0xffffffff);
    }
}

/// @dev Pinned values are proposed pilot configuration pending owner approval.
/// See docs/SHADOW_FLOAT_MAINNET_PILOT_TEST_PLAN.md.
contract ShadowFloatMainnetPilotLifecycleTest {
    VmPilotLifecycle private constant vm = VmPilotLifecycle(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant USDC = 1e6;

    uint256 private constant MAXIMUM_PROTOCOL_RESERVE = 50 * USDC;
    uint256 private constant MAXIMUM_LINE_RESERVE = 10 * USDC;
    uint256 private constant MAXIMUM_LINE_SPEND = 10 * USDC;
    uint256 private constant MAXIMUM_PER_SPEND = 2 * USDC;
    uint256 private constant MAXIMUM_DAILY_SPEND = 4 * USDC;
    uint256 private constant INITIAL_PROTOCOL_RESERVE = 25 * USDC;
    uint256 private constant INITIAL_LINE_RESERVE = 5 * USDC;
    uint256 private constant INITIAL_LINE_SPEND = 5 * USDC;
    uint256 private constant INITIAL_PER_SPEND = 1 * USDC;
    uint256 private constant INITIAL_DAILY_SPEND = 2 * USDC;
    uint64 private constant MINIMUM_REPAYMENT_WINDOW = 1 hours;
    uint64 private constant MAXIMUM_REPAYMENT_WINDOW = 7 days;
    uint64 private constant GOVERNANCE_DELAY = 2 days;

    uint256 private constant PILOT_RESERVE = 1 * USDC;
    uint256 private constant PILOT_LINE_SPEND_CAP = 3 * USDC;
    uint256 private constant PILOT_DAILY_SPEND_CAP = 1 * USDC;
    uint256 private constant PILOT_LINE_TERM = 60 days;
    uint64 private constant PILOT_REPAYMENT_WINDOW = 7 days;
    uint256 private constant PILOT_PROVIDER_PER_SPEND_CAP = 1 * USDC;
    uint256 private constant PILOT_PROVIDER_DAILY_CAP = 1 * USDC;
    uint256 private constant PILOT_PROVIDER_TERM = 60 days;
    uint256 private constant PILOT_PURCHASE = 1 * USDC;
    uint256 private constant PARTIAL_REPAYMENT = 400_000;

    uint256 private constant PILOT_START = 20_714 days + 9 hours;
    uint256 private constant SPONSOR_FUNDS = 10 * USDC;
    uint256 private constant AGENT_FUNDS = 10 * USDC;
    uint256 private constant SPONSOR_PK = 0x5901;
    uint256 private constant AGENT_PK = 0xA901;
    uint256 private constant ACCOUNT_OWNER_PK = 0xC901;
    uint256 private constant OUTSIDER_PK = 0xD901;
    address private constant PROVIDER = address(0xBEEF);
    address private constant EXECUTOR = address(0xE7EC);
    bytes32 private constant PILOT_ENDPOINT = keccak256("x402://pilot-provider/query.v1");
    bytes32 private constant UNAPPROVED_ENDPOINT = keccak256("x402://pilot-provider/bulk-export.v1");

    MockAsset private usdc;
    ShadowFloatMainnet private float;
    address private sponsor;
    address private agent;
    address private accountOwner;

    function setUp() public {
        vm.warp(PILOT_START);
        sponsor = vm.addr(SPONSOR_PK);
        agent = vm.addr(AGENT_PK);
        accountOwner = vm.addr(ACCOUNT_OWNER_PK);

        usdc = new MockAsset("Mock USDC", "USDC", 6);
        ShadowFloatMainnet.Limits memory maxima = ShadowFloatMainnet.Limits({
            protocolReserve: MAXIMUM_PROTOCOL_RESERVE,
            lineReserve: MAXIMUM_LINE_RESERVE,
            lineSpend: MAXIMUM_LINE_SPEND,
            perSpend: MAXIMUM_PER_SPEND,
            dailySpend: MAXIMUM_DAILY_SPEND
        });
        ShadowFloatMainnet.Limits memory initial = ShadowFloatMainnet.Limits({
            protocolReserve: INITIAL_PROTOCOL_RESERVE,
            lineReserve: INITIAL_LINE_RESERVE,
            lineSpend: INITIAL_LINE_SPEND,
            perSpend: INITIAL_PER_SPEND,
            dailySpend: INITIAL_DAILY_SPEND
        });
        float = new ShadowFloatMainnet(
            address(usdc),
            block.chainid,
            maxima,
            initial,
            MINIMUM_REPAYMENT_WINDOW,
            MAXIMUM_REPAYMENT_WINDOW,
            GOVERNANCE_DELAY
        );

        usdc.mint(sponsor, SPONSOR_FUNDS);
        usdc.mint(agent, AGENT_FUNDS);
        _approve(sponsor);
        _approve(agent);
    }

    function testPinnedDeploymentAndPilotLineConfiguration() public {
        _assertEq(float.deploymentChainId(), block.chainid, "chain not bound");
        _assertTrue(address(float.usdc()) == address(usdc), "token not bound");
        _assertEq(float.maximumProtocolReserve(), MAXIMUM_PROTOCOL_RESERVE, "wrong protocol maximum");
        _assertEq(float.maximumLineReserve(), MAXIMUM_LINE_RESERVE, "wrong line reserve maximum");
        _assertEq(float.maximumLineSpend(), MAXIMUM_LINE_SPEND, "wrong line spend maximum");
        _assertEq(float.maximumPerSpend(), MAXIMUM_PER_SPEND, "wrong per-spend maximum");
        _assertEq(float.maximumDailySpend(), MAXIMUM_DAILY_SPEND, "wrong daily maximum");
        (uint256 protocolReserve, uint256 lineReserve, uint256 lineSpend, uint256 perSpend, uint256 dailySpend) =
            float.effectiveLimits();
        _assertEq(protocolReserve, INITIAL_PROTOCOL_RESERVE, "wrong effective protocol reserve");
        _assertEq(lineReserve, INITIAL_LINE_RESERVE, "wrong effective line reserve");
        _assertEq(lineSpend, INITIAL_LINE_SPEND, "wrong effective line spend");
        _assertEq(perSpend, INITIAL_PER_SPEND, "wrong effective per-spend");
        _assertEq(dailySpend, INITIAL_DAILY_SPEND, "wrong effective daily spend");
        _assertEq(float.minimumRepaymentWindow(), MINIMUM_REPAYMENT_WINDOW, "wrong minimum repayment window");
        _assertEq(float.maximumRepaymentWindow(), MAXIMUM_REPAYMENT_WINDOW, "wrong maximum repayment window");
        _assertEq(float.governanceDelay(), GOVERNANCE_DELAY, "wrong governance delay");
        _assertTrue(!float.openingsPaused() && !float.spendsPaused(), "deployment starts paused");
        _assertTrue(!float.sponsorAllowed(sponsor), "sponsor allowlisted without owner action");
        _assertTrue(sponsor != agent, "sponsor and agent share an address");

        bytes32 lineId = _openPilotLine(agent);
        ShadowFloatMainnet.Line memory line = float.getLine(lineId);
        _assertTrue(line.sponsor == sponsor && line.agent == agent, "wrong line parties");
        _assertEq(line.epoch, 1, "wrong line epoch");
        _assertEq(line.termsVersion, 1, "wrong terms version");
        _assertEq(line.reserveCap, PILOT_RESERVE, "wrong reserve cap");
        _assertEq(line.lineSpendCap, PILOT_LINE_SPEND_CAP, "wrong line spend cap");
        _assertEq(line.dailySpendCap, PILOT_DAILY_SPEND_CAP, "wrong line daily cap");
        _assertEq(line.expiry, PILOT_START + PILOT_LINE_TERM, "wrong line expiry");
        _assertEq(line.maximumRepaymentWindow, PILOT_REPAYMENT_WINDOW, "wrong line repayment window");
        (bytes32 endpointHash, uint64 providerExpiry,, bool active, uint256 perSpendCap, uint256 providerDailyCap,) =
            float.providerPolicies(lineId, PROVIDER);
        _assertTrue(active && endpointHash == PILOT_ENDPOINT, "wrong provider endpoint");
        _assertEq(providerExpiry, PILOT_START + PILOT_PROVIDER_TERM, "wrong provider expiry");
        _assertEq(perSpendCap, PILOT_PROVIDER_PER_SPEND_CAP, "wrong provider per-spend cap");
        _assertEq(providerDailyCap, PILOT_PROVIDER_DAILY_CAP, "wrong provider daily cap");
    }

    function testPilotPathThreeCyclesOneRefusalAndSponsorReclaim() public {
        ShadowFloatMainnet.OpenLineParams memory params = _pilotParams(agent);
        vm.prank(sponsor);
        (bool openedBeforeAllowlist, bytes memory openError) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.openLine.selector, params));
        _assertTrue(!openedBeforeAllowlist, "unlisted sponsor opened a line");
        _assertRevertSelector(openError, ShadowFloatMainnet.Unauthorized.selector);

        float.setSponsorAllowed(sponsor, true);
        vm.recordLogs();
        vm.prank(sponsor);
        bytes32 lineId = float.openLine(params);
        VmPilotLifecycle.Log[] memory openLogs = vm.getRecordedLogs();
        VmPilotLifecycle.Log memory opened = _onlyLog(openLogs, address(float), ShadowFloatMainnet.LineOpened.selector);
        _assertTrue(opened.topics[1] == lineId, "LineOpened line mismatch");
        _assertTrue(opened.topics[2] == _topic(sponsor), "LineOpened sponsor mismatch");
        _assertTrue(opened.topics[3] == _topic(agent), "LineOpened agent mismatch");
        (uint64 epoch, uint256 reserve, uint64 termsVersion) = abi.decode(opened.data, (uint64, uint256, uint64));
        _assertEq(epoch, 1, "LineOpened epoch mismatch");
        _assertEq(reserve, PILOT_RESERVE, "LineOpened reserve mismatch");
        _assertEq(termsVersion, 1, "LineOpened terms version mismatch");
        VmPilotLifecycle.Log memory policySet =
            _onlyLog(openLogs, address(float), ShadowFloatMainnet.ProviderPolicySet.selector);
        _assertTrue(policySet.topics[1] == lineId, "ProviderPolicySet line mismatch");
        _assertTrue(policySet.topics[2] == _topic(PROVIDER), "ProviderPolicySet provider mismatch");
        (
            bytes32 endpointHash,
            uint256 perSpendCap,
            uint256 providerDailyCap,
            uint64 providerExpiry,
            bool active,
            uint64 policyTermsVersion
        ) = abi.decode(policySet.data, (bytes32, uint256, uint256, uint64, bool, uint64));
        _assertTrue(active && endpointHash == PILOT_ENDPOINT, "ProviderPolicySet endpoint mismatch");
        _assertEq(perSpendCap, PILOT_PROVIDER_PER_SPEND_CAP, "ProviderPolicySet per-spend mismatch");
        _assertEq(providerDailyCap, PILOT_PROVIDER_DAILY_CAP, "ProviderPolicySet daily cap mismatch");
        _assertEq(providerExpiry, PILOT_START + PILOT_PROVIDER_TERM, "ProviderPolicySet expiry mismatch");
        _assertEq(policyTermsVersion, 1, "ProviderPolicySet terms version mismatch");
        _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, 0);
        _assertEq(usdc.balanceOf(sponsor), SPONSOR_FUNDS - PILOT_RESERVE, "reserve not funded exactly");
        _assertEq(float.totalCommittedCapital(), PILOT_RESERVE, "wrong committed capital");
        _assertSolvent();

        _purchase(lineId, 1, 1 * PILOT_PURCHASE);
        vm.prank(sponsor);
        (bool closedWithDebt, bytes memory closeError) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.closeLine.selector, lineId));
        _assertTrue(!closedWithDebt, "line closed with debt outstanding");
        _assertRevertSelector(closeError, ShadowFloatMainnet.InvalidState.selector);
        _repayInFull(lineId);

        ShadowFloatMainnet.SpendIntent memory refused = _intent(lineId, agent, PILOT_PURCHASE, 2);
        refused.endpointHash = UNAPPROVED_ENDPOINT;
        _assertRecordedRefusal(refused, _sign(AGENT_PK, refused), ShadowFloatMainnet.BlockReason.ENDPOINT_NOT_ALLOWED);

        vm.warp(block.timestamp + 1 days);
        _purchase(lineId, 3, 2 * PILOT_PURCHASE);
        _repayInFull(lineId);

        vm.warp(block.timestamp + 1 days);
        _purchase(lineId, 4, 3 * PILOT_PURCHASE);
        _repayInFull(lineId);

        vm.recordLogs();
        vm.prank(sponsor);
        float.closeLine(lineId);
        VmPilotLifecycle.Log memory closed =
            _onlyLog(vm.getRecordedLogs(), address(float), ShadowFloatMainnet.LineClosed.selector);
        _assertTrue(closed.topics[1] == lineId, "LineClosed line mismatch");
        _assertTrue(closed.topics[2] == _topic(sponsor), "LineClosed sponsor mismatch");
        _assertEq(abi.decode(closed.data, (uint256)), PILOT_RESERVE, "LineClosed amount mismatch");

        _assertLine(lineId, ShadowFloatMainnet.LineState.CLOSED, 0, 0, PILOT_LINE_SPEND_CAP);
        _assertEq(float.getLine(lineId).recoveryAvailable, 0, "closed line holds recovery");
        _assertEq(float.totalCommittedCapital(), 0, "closed line still committed");
        _assertEq(float.totalSponsorObligations(), 0, "closed line still owed");
        _assertEq(usdc.balanceOf(address(float)), 0, "contract retained funds");
        _assertEq(usdc.balanceOf(sponsor), SPONSOR_FUNDS, "sponsor did not reclaim exact reserve");
        _assertEq(usdc.balanceOf(PROVIDER), 3 * PILOT_PURCHASE, "provider not paid exactly three times");
        _assertEq(usdc.balanceOf(agent), AGENT_FUNDS - 3 * PILOT_PURCHASE, "agent repayment total mismatch");
    }

    function testSecondDrawWhileDrawnRevertsWithoutConsumingNonce() public {
        bytes32 lineId = _openPilotLine(agent);
        _purchase(lineId, 1, PILOT_PURCHASE);

        ShadowFloatMainnet.SpendIntent memory queued = _intent(lineId, agent, PILOT_PURCHASE, 2);
        queued.signatureExpiry = block.timestamp + 2 days;
        queued.dueAt = block.timestamp + 3 days;
        bytes memory queuedSignature = _sign(AGENT_PK, queued);
        _assertSubmitReverts(
            queued, queuedSignature, ShadowFloatMainnet.InvalidState.selector, "second draw while DRAWN"
        );
        _assertTrue(!float.nonceUsed(lineId, queued.nonce), "DRAWN revert consumed nonce");
        _assertEq(float.receiptStatus(float.hashSpendIntent(queued)), 0, "DRAWN revert wrote a receipt");
        _assertEq(usdc.balanceOf(PROVIDER), PILOT_PURCHASE, "DRAWN revert paid provider");
        _assertLine(lineId, ShadowFloatMainnet.LineState.DRAWN, 0, PILOT_PURCHASE, PILOT_PURCHASE);

        _repayInFull(lineId);
        _warpToNextUtcDay();
        _assertPaid(queued, queuedSignature, 2 * PILOT_PURCHASE);
    }

    function testPartialRepaymentRestoresReserveButKeepsLineDrawn() public {
        bytes32 lineId = _openPilotLine(agent);
        ShadowFloatMainnet.SpendIntent memory first = _purchase(lineId, 1, PILOT_PURCHASE);

        vm.prank(agent);
        float.repay(lineId, PARTIAL_REPAYMENT);
        _assertLine(
            lineId,
            ShadowFloatMainnet.LineState.DRAWN,
            PARTIAL_REPAYMENT,
            PILOT_PURCHASE - PARTIAL_REPAYMENT,
            PILOT_PURCHASE
        );
        _assertEq(float.getLine(lineId).dueAt, first.dueAt, "partial repayment moved dueAt");
        _assertEq(float.totalSponsorObligations(), PARTIAL_REPAYMENT, "partial repayment not restored");
        _assertSolvent();

        _warpToNextUtcDay();
        ShadowFloatMainnet.SpendIntent memory fits = _intent(lineId, agent, PARTIAL_REPAYMENT, 2);
        _assertSubmitReverts(
            fits, _sign(AGENT_PK, fits), ShadowFloatMainnet.InvalidState.selector, "draw while partially repaid"
        );
        _assertTrue(!float.nonceUsed(lineId, fits.nonce), "DRAWN revert consumed nonce");
        _assertEq(float.receiptStatus(float.hashSpendIntent(fits)), 0, "DRAWN revert wrote a receipt");
        _assertEq(usdc.balanceOf(PROVIDER), PILOT_PURCHASE, "DRAWN revert paid provider");

        vm.prank(agent);
        float.repay(lineId, PILOT_PURCHASE - PARTIAL_REPAYMENT);
        _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, PILOT_PURCHASE);
        _assertSolvent();
    }

    function testPolicyRefusalWhileOpenIsRecordedAndCostsNoCapacity() public {
        bytes32 lineId = _openPilotLine(agent);
        ShadowFloatMainnet.SpendIntent memory refused = _intent(lineId, agent, PILOT_PURCHASE, 1);
        refused.endpointHash = UNAPPROVED_ENDPOINT;
        bytes memory refusedSignature = _sign(AGENT_PK, refused);
        _assertRecordedRefusal(refused, refusedSignature, ShadowFloatMainnet.BlockReason.ENDPOINT_NOT_ALLOWED);
        _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, 0);
        _assertEq(float.getLine(lineId).spentToday, 0, "refusal consumed daily capacity");

        _purchase(lineId, 2, PILOT_PURCHASE);
        _repayInFull(lineId);

        vm.prank(sponsor);
        float.setProviderPolicy(
            lineId,
            PROVIDER,
            UNAPPROVED_ENDPOINT,
            PILOT_PROVIDER_PER_SPEND_CAP,
            PILOT_PROVIDER_DAILY_CAP,
            uint64(block.timestamp + PILOT_PROVIDER_TERM),
            true
        );
        _assertSubmitReverts(
            refused,
            refusedSignature,
            ShadowFloatMainnet.StaleTerms.selector,
            "refused intent paid after endpoint approval"
        );
        _assertEq(float.receiptStatus(float.hashSpendIntent(refused)), 1, "refusal receipt changed");
        _assertEq(usdc.balanceOf(PROVIDER), PILOT_PURCHASE, "refused intent moved funds");
    }

    function testPinnedLimitsCapCumulativePrincipalAtThreeUsdc() public {
        bytes32 lineId = _openPilotLine(agent);
        _purchase(lineId, 1, PILOT_PURCHASE);
        _repayInFull(lineId);

        vm.warp((block.timestamp / 1 days + 1) * 1 days - 1);
        ShadowFloatMainnet.SpendIntent memory sameDay = _intent(lineId, agent, PILOT_PURCHASE, 2);
        _assertRecordedRefusal(sameDay, _sign(AGENT_PK, sameDay), ShadowFloatMainnet.BlockReason.DAILY_SPEND_CAP);

        _warpToNextUtcDay();
        _assertTrue(block.timestamp - PILOT_START < 1 days, "daily reset needed a full 24 hours");
        _purchase(lineId, 3, 2 * PILOT_PURCHASE);
        _repayInFull(lineId);

        vm.warp(block.timestamp + 1 days);
        _purchase(lineId, 4, 3 * PILOT_PURCHASE);
        _repayInFull(lineId);

        vm.warp(block.timestamp + 1 days);
        ShadowFloatMainnet.SpendIntent memory fourth = _intent(lineId, agent, PILOT_PURCHASE, 5);
        _assertRecordedRefusal(fourth, _sign(AGENT_PK, fourth), ShadowFloatMainnet.BlockReason.LINE_SPEND_CAP);
        ShadowFloatMainnet.SpendIntent memory oneUnit = _intent(lineId, agent, 1, 6);
        _assertRecordedRefusal(oneUnit, _sign(AGENT_PK, oneUnit), ShadowFloatMainnet.BlockReason.LINE_SPEND_CAP);

        _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, PILOT_LINE_SPEND_CAP);
        _assertEq(usdc.balanceOf(PROVIDER), PILOT_LINE_SPEND_CAP, "provider received more than the line spend cap");
    }

    function testPinnedDailyCapBoundsAmountNotPurchaseCount() public {
        bytes32 lineId = _openPilotLine(agent);
        uint256 half = PILOT_PURCHASE / 2;
        for (uint256 nonce = 1; nonce <= 2; ++nonce) {
            ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, agent, half, nonce);
            _assertPaid(intent, _sign(AGENT_PK, intent), nonce * half);
            vm.prank(agent);
            float.repay(lineId, half);
            _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, nonce * half);
        }
        _assertEq(block.timestamp / 1 days, PILOT_START / 1 days, "cycles left the UTC day");
        _assertEq(float.getLine(lineId).spentToday, PILOT_DAILY_SPEND_CAP, "two halves did not fill the daily cap");

        ShadowFloatMainnet.SpendIntent memory third = _intent(lineId, agent, half, 3);
        _assertRecordedRefusal(third, _sign(AGENT_PK, third), ShadowFloatMainnet.BlockReason.DAILY_SPEND_CAP);
        _assertEq(usdc.balanceOf(PROVIDER), PILOT_DAILY_SPEND_CAP, "provider not paid exactly two halves");
    }

    function testPurchasesStopOneRepaymentWindowBeforeLineExpiry() public {
        bytes32 lineId = _openPilotLine(agent);
        uint256 lineExpiry = float.getLine(lineId).expiry;

        vm.warp(lineExpiry - MINIMUM_REPAYMENT_WINDOW);
        ShadowFloatMainnet.SpendIntent memory last = _intent(lineId, agent, PILOT_PURCHASE, 1);
        last.dueAt = lineExpiry;
        _assertPaid(last, _sign(AGENT_PK, last), PILOT_PURCHASE);
        _repayInFull(lineId);

        vm.warp(lineExpiry - MINIMUM_REPAYMENT_WINDOW + 1);
        ShadowFloatMainnet.SpendIntent memory late = _intent(lineId, agent, PILOT_PURCHASE, 2);
        late.dueAt = lineExpiry;
        _assertSubmitReverts(
            late, _sign(AGENT_PK, late), ShadowFloatMainnet.InvalidIntent.selector, "purchase in final window"
        );

        vm.warp(lineExpiry + 1);
        ShadowFloatMainnet.SpendIntent memory expired = _intent(lineId, agent, PILOT_PURCHASE, 3);
        expired.dueAt = block.timestamp + MINIMUM_REPAYMENT_WINDOW;
        _assertSubmitReverts(
            expired, _sign(AGENT_PK, expired), ShadowFloatMainnet.InvalidIntent.selector, "purchase after expiry"
        );
        _assertTrue(!float.nonceUsed(lineId, late.nonce), "final-window revert consumed nonce");
        _assertTrue(!float.nonceUsed(lineId, expired.nonce), "expiry revert consumed nonce");
        _assertEq(float.receiptStatus(float.hashSpendIntent(expired)), 0, "expiry revert wrote a receipt");

        vm.prank(sponsor);
        float.closeLine(lineId);
        _assertEq(usdc.balanceOf(sponsor), SPONSOR_FUNDS, "sponsor could not reclaim after expiry");
        _assertEq(usdc.balanceOf(PROVIDER), PILOT_PURCHASE, "expired line paid provider");
    }

    function testPaidIntentCannotPayTwiceEvenAfterRepayment() public {
        bytes32 lineId = _openPilotLine(agent);
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, agent, PILOT_PURCHASE, 1);
        intent.signatureExpiry = block.timestamp + 2 days;
        intent.dueAt = block.timestamp + 3 days;
        bytes memory signature = _sign(AGENT_PK, intent);
        bytes32 digest = float.hashSpendIntent(intent);
        _assertPaid(intent, signature, PILOT_PURCHASE);

        _assertSubmitReverts(
            intent, signature, ShadowFloatMainnet.NonceUnavailable.selector, "duplicate paid while DRAWN"
        );
        _repayInFull(lineId);
        _assertSubmitReverts(
            intent, signature, ShadowFloatMainnet.NonceUnavailable.selector, "duplicate paid after repayment"
        );
        _warpToNextUtcDay();
        _assertSubmitReverts(
            intent, signature, ShadowFloatMainnet.NonceUnavailable.selector, "duplicate paid on a later day"
        );

        _assertEq(float.receiptStatus(digest), 2, "paid receipt changed");
        _assertEq(usdc.balanceOf(PROVIDER), PILOT_PURCHASE, "provider paid more than once");
        _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, PILOT_PURCHASE);
    }

    function testDeployedSmartAccountAgentCompletesCycle() public {
        PilotSmartAccount account = new PilotSmartAccount(accountOwner);
        bytes32 lineId = _openPilotLine(address(account));
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, address(account), PILOT_PURCHASE, 1);
        bytes memory signature = _accountSignature(ACCOUNT_OWNER_PK, intent);
        _assertEq(signature.length, 96, "account signature is not the wrapped format");

        _assertSubmitReverts(
            intent,
            _accountSignature(OUTSIDER_PK, intent),
            ShadowFloatMainnet.InvalidSignature.selector,
            "account accepted a non-owner signature"
        );
        _assertTrue(!float.nonceUsed(lineId, intent.nonce), "rejected account signature consumed nonce");
        _assertPaid(intent, signature, PILOT_PURCHASE);

        usdc.mint(address(account), PILOT_PURCHASE);
        vm.prank(address(account));
        usdc.approve(address(float), PILOT_PURCHASE);
        vm.prank(address(account));
        float.repay(lineId, PILOT_PURCHASE);
        _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, PILOT_PURCHASE);

        vm.prank(sponsor);
        float.closeLine(lineId);
        _assertLine(lineId, ShadowFloatMainnet.LineState.CLOSED, 0, 0, PILOT_PURCHASE);
        _assertEq(usdc.balanceOf(sponsor), SPONSOR_FUNDS, "sponsor did not reclaim reserve");
        _assertEq(usdc.balanceOf(address(float)), 0, "contract retained funds");
    }

    function testUndeployedSmartAccountAgentIsRejectedUntilDeployed() public {
        bytes32 salt = keccak256("pilot-agent-account");
        address counterfactual = _predictAccount(salt);
        _assertEq(counterfactual.code.length, 0, "account already deployed");
        bytes32 lineId = _openPilotLine(counterfactual);
        ShadowFloatMainnet.SpendIntent memory intent = _intent(lineId, counterfactual, PILOT_PURCHASE, 1);
        bytes memory signature = _accountSignature(ACCOUNT_OWNER_PK, intent);

        _assertSubmitReverts(
            intent, signature, ShadowFloatMainnet.InvalidSignature.selector, "undeployed account signature accepted"
        );
        _assertSubmitReverts(
            intent,
            _sign(ACCOUNT_OWNER_PK, intent),
            ShadowFloatMainnet.InvalidSignature.selector,
            "owner key signature accepted for account address"
        );
        _assertTrue(!float.nonceUsed(lineId, intent.nonce), "signature revert consumed nonce");
        _assertEq(float.receiptStatus(float.hashSpendIntent(intent)), 0, "signature revert wrote a receipt");
        _assertEq(usdc.balanceOf(PROVIDER), 0, "signature revert paid provider");
        _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, 0);

        PilotSmartAccount account = new PilotSmartAccount{salt: salt}(accountOwner);
        _assertTrue(address(account) == counterfactual, "account deployed at a different address");
        _assertPaid(intent, signature, PILOT_PURCHASE);
    }

    function testDefaultPathOnSeparateLineRoutesRecoveryToSponsor() public {
        bytes32 lineId = _openPilotLine(agent);
        ShadowFloatMainnet.SpendIntent memory drawn = _purchase(lineId, 1, PILOT_PURCHASE);

        vm.warp(drawn.dueAt - 1);
        _assertTrue(!float.isMatured(lineId), "line matured before dueAt");
        vm.prank(sponsor);
        (bool earlyDefault, bytes memory earlyError) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.declareDefault.selector, lineId));
        _assertTrue(!earlyDefault, "default executed before dueAt");
        _assertRevertSelector(earlyError, ShadowFloatMainnet.TooEarly.selector);

        vm.warp(drawn.dueAt);
        _assertTrue(float.isMatured(lineId), "line not matured at dueAt");
        vm.recordLogs();
        vm.prank(sponsor);
        float.declareDefault(lineId);
        VmPilotLifecycle.Log memory defaulted =
            _onlyLog(vm.getRecordedLogs(), address(float), ShadowFloatMainnet.LineDefaulted.selector);
        _assertTrue(defaulted.topics[1] == lineId, "LineDefaulted line mismatch");
        (uint256 defaultedPrincipal, uint256 defaultedDueAt) = abi.decode(defaulted.data, (uint256, uint256));
        _assertEq(defaultedPrincipal, PILOT_PURCHASE, "LineDefaulted principal mismatch");
        _assertEq(defaultedDueAt, drawn.dueAt, "LineDefaulted dueAt mismatch");
        _assertLine(lineId, ShadowFloatMainnet.LineState.DEFAULTED, 0, PILOT_PURCHASE, PILOT_PURCHASE);

        vm.prank(sponsor);
        (bool emptyClaim, bytes memory emptyClaimError) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.claimDefaulted.selector, lineId));
        _assertTrue(!emptyClaim, "claim paid with nothing recoverable");
        _assertRevertSelector(emptyClaimError, ShadowFloatMainnet.InvalidAmount.selector);

        vm.prank(agent);
        float.repay(lineId, PARTIAL_REPAYMENT);
        _assertLine(
            lineId, ShadowFloatMainnet.LineState.DEFAULTED, 0, PILOT_PURCHASE - PARTIAL_REPAYMENT, PILOT_PURCHASE
        );
        _assertEq(float.getLine(lineId).recoveryAvailable, PARTIAL_REPAYMENT, "recovery not assigned to sponsor");

        uint256 sponsorBefore = usdc.balanceOf(sponsor);
        vm.recordLogs();
        vm.prank(sponsor);
        float.claimDefaulted(lineId);
        VmPilotLifecycle.Log memory claimed =
            _onlyLog(vm.getRecordedLogs(), address(float), ShadowFloatMainnet.SponsorClaimed.selector);
        _assertEq(abi.decode(claimed.data, (uint256)), PARTIAL_REPAYMENT, "SponsorClaimed amount mismatch");
        _assertEq(usdc.balanceOf(sponsor), sponsorBefore + PARTIAL_REPAYMENT, "sponsor claim not exact");

        vm.prank(agent);
        float.repay(lineId, PILOT_PURCHASE - PARTIAL_REPAYMENT);
        _assertLine(lineId, ShadowFloatMainnet.LineState.DEFAULTED, 0, 0, PILOT_PURCHASE);
        _assertEq(
            float.getLine(lineId).recoveryAvailable, PILOT_PURCHASE - PARTIAL_REPAYMENT, "recovery not accumulated"
        );

        ShadowFloatMainnet.SpendIntent memory afterDefault = _intent(lineId, agent, PILOT_PURCHASE, 2);
        _assertSubmitReverts(
            afterDefault,
            _sign(AGENT_PK, afterDefault),
            ShadowFloatMainnet.InvalidIntent.selector,
            "repaid defaulted line paid a purchase"
        );
        _assertTrue(!float.nonceUsed(lineId, afterDefault.nonce), "defaulted-line revert consumed nonce");

        vm.prank(sponsor);
        float.claimDefaulted(lineId);
        _assertEq(usdc.balanceOf(sponsor), SPONSOR_FUNDS, "sponsor recovery not exact");
        _assertEq(float.getLine(lineId).recoveryAvailable, 0, "recovery left unclaimed");
        _assertEq(float.totalCommittedCapital(), 0, "recovered line still committed");
        _assertEq(float.totalSponsorObligations(), 0, "recovered line still owed");
        _assertEq(usdc.balanceOf(address(float)), 0, "contract retained funds");
        _assertEq(usdc.balanceOf(PROVIDER), PILOT_PURCHASE, "default path paid provider twice");
    }

    function _approve(address actor) private {
        vm.prank(actor);
        usdc.approve(address(float), type(uint256).max);
    }

    function _pilotParams(address lineAgent) private view returns (ShadowFloatMainnet.OpenLineParams memory) {
        return ShadowFloatMainnet.OpenLineParams({
            agent: lineAgent,
            reserve: PILOT_RESERVE,
            lineSpendCap: PILOT_LINE_SPEND_CAP,
            dailySpendCap: PILOT_DAILY_SPEND_CAP,
            lineExpiry: uint64(block.timestamp + PILOT_LINE_TERM),
            maximumRepaymentWindow: PILOT_REPAYMENT_WINDOW,
            provider: PROVIDER,
            endpointHash: PILOT_ENDPOINT,
            providerPerSpendCap: PILOT_PROVIDER_PER_SPEND_CAP,
            providerDailyCap: PILOT_PROVIDER_DAILY_CAP,
            providerExpiry: uint64(block.timestamp + PILOT_PROVIDER_TERM)
        });
    }

    function _openPilotLine(address lineAgent) private returns (bytes32 lineId) {
        float.setSponsorAllowed(sponsor, true);
        ShadowFloatMainnet.OpenLineParams memory params = _pilotParams(lineAgent);
        vm.prank(sponsor);
        return float.openLine(params);
    }

    function _intent(bytes32 lineId, address lineAgent, uint256 principal, uint256 nonce)
        private
        view
        returns (ShadowFloatMainnet.SpendIntent memory intent)
    {
        intent = ShadowFloatMainnet.SpendIntent({
            agent: lineAgent,
            sponsor: sponsor,
            lineId: lineId,
            lineEpoch: float.getLine(lineId).epoch,
            termsHash: float.currentTermsHash(lineId, PROVIDER),
            provider: PROVIDER,
            endpointHash: PILOT_ENDPOINT,
            principal: principal,
            maximumTotalDebt: principal,
            dueAt: block.timestamp + 1 days,
            nonce: nonce,
            signatureExpiry: block.timestamp + 1 hours,
            executor: EXECUTOR
        });
    }

    function _sign(uint256 privateKey, ShadowFloatMainnet.SpendIntent memory intent)
        private
        returns (bytes memory signature)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, float.hashSpendIntent(intent));
        return bytes.concat(r, s, bytes1(v));
    }

    function _accountSignature(uint256 ownerKey, ShadowFloatMainnet.SpendIntent memory intent)
        private
        returns (bytes memory signature)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, float.hashSpendIntent(intent));
        return abi.encode(r, s, v);
    }

    function _predictAccount(bytes32 salt) private view returns (address) {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(PilotSmartAccount).creationCode, abi.encode(accountOwner)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    function _submit(ShadowFloatMainnet.SpendIntent memory intent, bytes memory signature)
        private
        returns (bool paid, ShadowFloatMainnet.BlockReason reason)
    {
        vm.prank(EXECUTOR);
        return float.executeSpend(intent, signature);
    }

    function _purchase(bytes32 lineId, uint256 nonce, uint256 cumulativeAfter)
        private
        returns (ShadowFloatMainnet.SpendIntent memory intent)
    {
        intent = _intent(lineId, agent, PILOT_PURCHASE, nonce);
        _assertPaid(intent, _sign(AGENT_PK, intent), cumulativeAfter);
    }

    function _repayInFull(bytes32 lineId) private {
        uint256 cumulative = float.getLine(lineId).cumulativePrincipalPaid;
        vm.recordLogs();
        vm.prank(agent);
        float.repay(lineId, PILOT_PURCHASE);
        VmPilotLifecycle.Log memory repaid =
            _onlyLog(vm.getRecordedLogs(), address(float), ShadowFloatMainnet.Repaid.selector);
        _assertTrue(repaid.topics[1] == lineId, "Repaid line mismatch");
        _assertTrue(repaid.topics[2] == _topic(agent), "Repaid payer mismatch");
        (uint256 amount, uint256 principalRemaining) = abi.decode(repaid.data, (uint256, uint256));
        _assertEq(amount, PILOT_PURCHASE, "Repaid amount mismatch");
        _assertEq(principalRemaining, 0, "debt remains after full repayment");
        _assertLine(lineId, ShadowFloatMainnet.LineState.OPEN, PILOT_RESERVE, 0, cumulative);
        _assertEq(float.getLine(lineId).dueAt, 0, "full repayment left dueAt");
        _assertSolvent();
    }

    function _warpToNextUtcDay() private {
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
    }

    function _assertPaid(ShadowFloatMainnet.SpendIntent memory intent, bytes memory signature, uint256 cumulativeAfter)
        private
    {
        bytes32 digest = float.hashSpendIntent(intent);
        uint256 providerBefore = usdc.balanceOf(PROVIDER);
        ShadowFloatMainnet.Line memory before = float.getLine(intent.lineId);
        uint256 spentBefore = before.day == block.timestamp / 1 days ? before.spentToday : 0;
        vm.recordLogs();
        (bool paid, ShadowFloatMainnet.BlockReason reason) = _submit(intent, signature);
        VmPilotLifecycle.Log memory providerPaid =
            _onlyLog(vm.getRecordedLogs(), address(float), ShadowFloatMainnet.ProviderPaid.selector);
        _assertTrue(paid, "pilot purchase not paid");
        _assertEq(uint256(reason), uint256(ShadowFloatMainnet.BlockReason.NONE), "paid purchase has block reason");
        _assertTrue(providerPaid.topics[1] == digest, "ProviderPaid digest mismatch");
        _assertTrue(providerPaid.topics[2] == intent.lineId, "ProviderPaid line mismatch");
        _assertTrue(providerPaid.topics[3] == _topic(intent.provider), "ProviderPaid provider mismatch");
        (uint256 principal, uint256 dueAt) = abi.decode(providerPaid.data, (uint256, uint256));
        _assertEq(principal, intent.principal, "ProviderPaid principal mismatch");
        _assertEq(dueAt, intent.dueAt, "ProviderPaid dueAt mismatch");

        _assertEq(usdc.balanceOf(PROVIDER), providerBefore + intent.principal, "provider not paid exactly");
        _assertEq(float.receiptStatus(digest), 2, "paid receipt missing");
        _assertTrue(float.nonceUsed(intent.lineId, intent.nonce), "paid nonce not consumed");
        ShadowFloatMainnet.Line memory line = float.getLine(intent.lineId);
        _assertEq(uint256(line.state), uint256(ShadowFloatMainnet.LineState.DRAWN), "paid line not DRAWN");
        _assertEq(line.principalOutstanding, intent.principal, "debt not opened exactly");
        _assertEq(line.availableReserve, line.reserveCap - intent.principal, "reserve not reduced exactly");
        _assertEq(line.cumulativePrincipalPaid, cumulativeAfter, "cumulative principal mismatch");
        _assertEq(line.spentToday, spentBefore + intent.principal, "daily usage mismatch");
        _assertEq(line.dueAt, intent.dueAt, "dueAt not recorded");
        _assertSolvent();
    }

    function _assertRecordedRefusal(
        ShadowFloatMainnet.SpendIntent memory intent,
        bytes memory signature,
        ShadowFloatMainnet.BlockReason expected
    ) private {
        bytes32 digest = float.hashSpendIntent(intent);
        ShadowFloatMainnet.Line memory before = float.getLine(intent.lineId);
        uint256 providerBefore = usdc.balanceOf(PROVIDER);
        uint256 contractBefore = usdc.balanceOf(address(float));

        vm.recordLogs();
        (bool paid, ShadowFloatMainnet.BlockReason reason) = _submit(intent, signature);
        VmPilotLifecycle.Log[] memory logs = vm.getRecordedLogs();
        _assertTrue(!paid, "refused purchase paid");
        _assertEq(uint256(reason), uint256(expected), "wrong refusal reason");
        VmPilotLifecycle.Log memory blocked = _onlyLog(logs, address(float), ShadowFloatMainnet.SpendBlocked.selector);
        _assertTrue(blocked.topics[1] == digest, "SpendBlocked digest mismatch");
        _assertTrue(blocked.topics[2] == intent.lineId, "SpendBlocked line mismatch");
        _assertEq(uint256(blocked.topics[3]), intent.nonce, "SpendBlocked nonce mismatch");
        _assertEq(abi.decode(blocked.data, (uint8)), uint256(expected), "SpendBlocked reason mismatch");
        _assertEq(
            _countLogs(logs, address(float), ShadowFloatMainnet.ProviderPaid.selector), 0, "refusal paid provider"
        );
        _assertEq(_countLogs(logs, address(usdc), MockAsset.Transfer.selector), 0, "refusal moved USDC");

        _assertEq(float.receiptStatus(digest), 1, "refusal receipt missing");
        _assertTrue(float.nonceUsed(intent.lineId, intent.nonce), "refusal did not consume nonce");
        _assertEq(usdc.balanceOf(PROVIDER), providerBefore, "refusal changed provider balance");
        _assertEq(usdc.balanceOf(address(float)), contractBefore, "refusal changed contract balance");
        ShadowFloatMainnet.Line memory afterRefusal = float.getLine(intent.lineId);
        _assertEq(uint256(afterRefusal.state), uint256(before.state), "refusal changed line state");
        _assertEq(afterRefusal.availableReserve, before.availableReserve, "refusal changed reserve");
        _assertEq(afterRefusal.principalOutstanding, before.principalOutstanding, "refusal changed debt");
        _assertEq(
            afterRefusal.cumulativePrincipalPaid, before.cumulativePrincipalPaid, "refusal changed cumulative spend"
        );
        _assertEq(afterRefusal.spentToday, before.spentToday, "refusal changed daily usage");

        _assertSubmitReverts(
            intent, signature, ShadowFloatMainnet.NonceUnavailable.selector, "refused intent became payable"
        );
    }

    function _assertSubmitReverts(
        ShadowFloatMainnet.SpendIntent memory intent,
        bytes memory signature,
        bytes4 expectedError,
        string memory message
    ) private {
        vm.prank(EXECUTOR);
        (bool ok, bytes memory data) =
            address(float).call(abi.encodeWithSelector(ShadowFloatMainnet.executeSpend.selector, intent, signature));
        _assertTrue(!ok, message);
        _assertRevertSelector(data, expectedError);
    }

    function _assertRevertSelector(bytes memory data, bytes4 expectedError) private pure {
        _assertTrue(data.length == 4 && bytes4(data) == expectedError, "unexpected revert reason");
    }

    function _assertLine(
        bytes32 lineId,
        ShadowFloatMainnet.LineState state,
        uint256 availableReserve,
        uint256 principalOutstanding,
        uint256 cumulativePrincipalPaid
    ) private view {
        ShadowFloatMainnet.Line memory line = float.getLine(lineId);
        _assertEq(uint256(line.state), uint256(state), "wrong line state");
        _assertEq(line.availableReserve, availableReserve, "wrong available reserve");
        _assertEq(line.principalOutstanding, principalOutstanding, "wrong principal outstanding");
        _assertEq(line.cumulativePrincipalPaid, cumulativePrincipalPaid, "wrong cumulative principal");
    }

    function _assertSolvent() private view {
        _assertEq(usdc.balanceOf(address(float)), float.totalSponsorObligations(), "balance and obligations diverged");
    }

    function _onlyLog(VmPilotLifecycle.Log[] memory logs, address emitter, bytes32 topic0)
        private
        pure
        returns (VmPilotLifecycle.Log memory found)
    {
        _assertEq(_countLogs(logs, emitter, topic0), 1, "expected exactly one matching event");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length != 0 && logs[i].topics[0] == topic0) {
                return logs[i];
            }
        }
    }

    function _countLogs(VmPilotLifecycle.Log[] memory logs, address emitter, bytes32 topic0)
        private
        pure
        returns (uint256 count)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length != 0 && logs[i].topics[0] == topic0) {
                ++count;
            }
        }
    }

    function _topic(address account) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory message) private pure {
        require(actual == expected, message);
    }
}
