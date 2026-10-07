// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {ShadowFloatMainnetGuarded} from "../src/ShadowFloatMainnetGuarded.sol";

interface VmGatewayAtomic {
    function prank(address caller) external;
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

// Local models adapted from a supervised Arc Studio proof. They do not implement
// Circle attestation validation, Safe, ERC 4337, fees or crosschain settlement.
contract GatewayAtomicMintModel {
    MockAsset public immutable token;
    mapping(bytes32 => bool) public consumed;

    constructor() { token = new MockAsset("Mock USDC", "USDC", 6); }

    function mintToAccount(address account, uint256 amount, bytes32 identity) external {
        require(msg.sender == account, "wrong destination caller");
        require(!consumed[identity], "identity already used");
        consumed[identity] = true;
        token.mint(account, amount);
    }
}

contract GatewayAtomicAccountModel {
    address public immutable controller;
    event BatchResult(bool success);

    constructor(address controller_) { controller = controller_; }

    // Catch the inner revert, as some real accounts do. Outer success does not
    // establish funding, but all changes in the failed inner frame roll back.
    function execute(address[] calldata targets, bytes[] calldata data) external returns (bool) {
        require(msg.sender == controller, "not controller");
        require(targets.length == data.length, "length mismatch");
        (bool ok,) = address(this).call(abi.encodeCall(this.atomicBatch, (targets, data)));
        emit BatchResult(ok);
        return ok;
    }

    function atomicBatch(address[] calldata targets, bytes[] calldata data) external {
        require(msg.sender == address(this), "internal only");
        for (uint256 i; i < targets.length; ++i) {
            (bool ok, bytes memory reason) = targets[i].call(data[i]);
            if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        }
    }
}

contract ShadowFloatGuardedGatewayFundingTest {
    VmGatewayAtomic private constant vm = VmGatewayAtomic(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant CONTROLLER = address(0xC011);
    address private constant STRANGER = address(0xDEAD);
    address private constant PROVIDER = address(0xBEEF);
    uint256 private constant AGENT_TEST_KEY = 0xA11CE;
    uint256 private constant RESERVE = 100000;
    uint256 private constant PURCHASE = 5000;
    bytes32 private constant ENDPOINT = keccak256("test://gateway/report");
    GatewayAtomicMintModel private minter;
    GatewayAtomicAccountModel private account;
    MockAsset private token;
    ShadowFloatMainnetGuarded private shadow;
    address private agent;

    function setUp() public {
        agent = vm.addr(AGENT_TEST_KEY);
        minter = new GatewayAtomicMintModel();
        token = minter.token();
        account = new GatewayAtomicAccountModel(CONTROLLER);
        ShadowFloatMainnetGuarded.Limits memory limits = ShadowFloatMainnetGuarded.Limits(200000, RESERVE, PURCHASE, PURCHASE, PURCHASE);
        shadow = new ShadowFloatMainnetGuarded(address(token), block.chainid, limits, limits, 1 hours, 1 days, 1 days);
        shadow.setSponsorAllowed(address(account), true);
        shadow.setOpeningsPaused(false);
        shadow.setSpendsPaused(false);
    }

    function _params(uint256 reserve) private view returns (ShadowFloatMainnetGuarded.OpenLineParams memory) {
        return ShadowFloatMainnetGuarded.OpenLineParams(agent, reserve, PURCHASE, PURCHASE,
            uint64(block.timestamp + 1 days), 1 hours, PROVIDER, ENDPOINT, PURCHASE, PURCHASE,
            uint64(block.timestamp + 1 days));
    }

    function _batch(bytes32 identity, uint256 reserve) private view returns (address[] memory targets, bytes[] memory data) {
        targets = new address[](5); data = new bytes[](5);
        targets[0] = address(minter); data[0] = abi.encodeCall(minter.mintToAccount, (address(account), reserve, identity));
        targets[1] = address(token); data[1] = abi.encodeCall(token.approve, (address(shadow), 0));
        targets[2] = address(token); data[2] = abi.encodeCall(token.approve, (address(shadow), reserve));
        targets[3] = address(shadow); data[3] = abi.encodeCall(shadow.openLine, (_params(reserve)));
        targets[4] = address(token); data[4] = abi.encodeCall(token.approve, (address(shadow), 0));
    }

    function _execute(bytes32 identity, uint256 reserve) private returns (bool) {
        (address[] memory targets, bytes[] memory data) = _batch(identity, reserve);
        vm.prank(CONTROLLER);
        return account.execute(targets, data);
    }

    function _accountCall(address target, bytes memory callData) private returns (bool) {
        address[] memory targets = new address[](1); bytes[] memory data = new bytes[](1);
        targets[0] = target; data[0] = callData;
        vm.prank(CONTROLLER);
        return account.execute(targets, data);
    }

    function _unchanged(bytes32 identity) private view {
        require(!minter.consumed(identity), "mint consumed after rollback");
        require(token.balanceOf(address(account)) == 0, "account balance changed");
        require(token.balanceOf(address(shadow)) == 0, "reserve transferred after rollback");
        require(token.allowance(address(account), address(shadow)) == 0, "allowance left after rollback");
        require(shadow.nextLineEpoch(address(account), agent) == 0, "epoch advanced after rollback");
        require(shadow.totalCommittedCapital() == 0 && shadow.totalSponsorObligations() == 0, "accounting changed");
    }

    function testAtomicFundingKeepsAccountAsSponsorAndReclaimRecipient() public {
        require(_execute(keccak256("fund"), RESERVE), "funding failed");
        bytes32 id = shadow.activeLineId(address(account), agent);
        ShadowFloatMainnetGuarded.Line memory line = shadow.getLine(id);
        require(line.sponsor == address(account) && line.availableReserve == RESERVE, "wrong sponsor or reserve");
        require(token.allowance(address(account), address(shadow)) == 0, "allowance not reset");
        for (uint256 i; i < 2; ++i) {
            vm.prank(i == 0 ? CONTROLLER : STRANGER);
            (bool ok,) = address(shadow).call(abi.encodeCall(shadow.closeLine, (id)));
            require(!ok, "EOA could close account line");
        }
        require(_accountCall(address(shadow), abi.encodeCall(shadow.closeLine, (id))), "account reclaim failed");
        require(token.balanceOf(address(account)) == RESERVE && token.balanceOf(CONTROLLER) == 0, "wrong reclaim recipient");
        require(shadow.totalCommittedCapital() == 0 && shadow.totalSponsorObligations() == 0, "reserve not cleared");
    }

    function testAtomicFundingThenPurchaseAgentRepaymentAndReclaim() public {
        require(_execute(keccak256("cycle"), RESERVE), "funding failed");
        bytes32 id = shadow.activeLineId(address(account), agent);
        ShadowFloatMainnetGuarded.SpendIntent memory intent = ShadowFloatMainnetGuarded.SpendIntent(
            agent, address(account), id, 1, shadow.currentTermsHash(id, PROVIDER), PROVIDER, ENDPOINT,
            PURCHASE, PURCHASE, block.timestamp + 1 hours, 1, block.timestamp + 10 minutes, address(this));
        bytes32 digest = shadow.hashSpendIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_TEST_KEY, digest);
        (bool paid,) = shadow.executeSpend(intent, bytes.concat(r, s, bytes1(v)));
        require(paid && token.balanceOf(PROVIDER) == PURCHASE, "provider not paid exactly once");
        vm.prank(address(minter)); token.mint(agent, PURCHASE);
        vm.prank(agent); token.approve(address(shadow), PURCHASE);
        vm.prank(agent); shadow.repayForDraw(id, digest, PURCHASE);
        require(shadow.getLine(id).principalOutstanding == 0, "debt not cleared");
        require(_accountCall(address(shadow), abi.encodeCall(shadow.closeLine, (id))), "reclaim failed");
        require(token.balanceOf(address(account)) == RESERVE && token.balanceOf(address(shadow)) == 0, "reserve not reclaimed");
    }

    function testPausedOpeningRollsBackMintAndAllFunding() public {
        shadow.setOpeningsPaused(true);
        bytes32 identity = keccak256("paused");
        require(!_execute(identity, RESERVE), "failed inner batch returned success");
        _unchanged(identity);
    }

    function testUnadmittedAccountRollsBackMintAndAllFunding() public {
        shadow.setSponsorAllowed(address(account), false);
        bytes32 identity = keccak256("unadmitted");
        require(!_execute(identity, RESERVE), "unadmitted account funded");
        _unchanged(identity);
    }

    function testInvalidReserveRollsBackMintAndAllFunding() public {
        bytes32 identity = keccak256("oversized");
        require(!_execute(identity, RESERVE + 1), "oversized reserve funded");
        _unchanged(identity);
    }

    function testFinalCallFailureRollsBackAlreadyOpenedLine() public {
        bytes32 identity = keccak256("last-call-failure");
        (address[] memory targets, bytes[] memory data) = _batch(identity, RESERVE);
        // After funding, the empty account cannot transfer another token unit.
        targets[4] = address(token);
        data[4] = abi.encodeCall(token.transfer, (STRANGER, 1));
        vm.prank(CONTROLLER);
        require(!account.execute(targets, data), "final failure did not fail batch");
        _unchanged(identity);
    }

    function testDuplicateMintCannotOpenAnotherLineEvenAfterReclaim() public {
        bytes32 identity = keccak256("duplicate");
        require(_execute(identity, RESERVE), "first funding failed");
        bytes32 id = shadow.activeLineId(address(account), agent);
        require(_accountCall(address(shadow), abi.encodeCall(shadow.closeLine, (id))), "close failed");
        require(!_execute(identity, RESERVE), "original identity was reused");
        require(shadow.nextLineEpoch(address(account), agent) == 1, "duplicate advanced epoch");
        require(token.balanceOf(address(account)) == RESERVE && token.balanceOf(address(shadow)) == 0, "duplicate moved money");
    }

    function testStrangerCannotExecuteAccountOrClaimMint() public {
        (address[] memory targets, bytes[] memory data) = _batch(keccak256("stranger"), RESERVE);
        vm.prank(STRANGER);
        (bool ok,) = address(account).call(abi.encodeCall(account.execute, (targets, data)));
        require(!ok, "stranger controlled account");
        vm.prank(STRANGER);
        (ok,) = address(minter).call(abi.encodeCall(minter.mintToAccount, (address(account), RESERVE, keccak256("stranger"))));
        require(!ok, "wrong destination caller could mint");
    }

    function testDirectTokenTransferDoesNotCreateFundingLine() public {
        vm.prank(address(minter)); token.mint(address(account), RESERVE);
        require(_accountCall(address(token), abi.encodeCall(token.transfer, (address(shadow), RESERVE))), "transfer failed");
        require(shadow.activeLineId(address(account), agent) == bytes32(0), "direct transfer created line");
        require(shadow.totalCommittedCapital() == 0 && shadow.totalSponsorObligations() == 0, "untracked funds credited");
    }
}
