// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "../src/Script.sol";
import {ShadowFloatMainnet} from "../src/ShadowFloatMainnet.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface VmDeployMainnet {
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
}

// Non-funding deployment of the ShadowFloatMainnet candidate. Every value comes
// from env; nothing defaults in code. The simulated deployment is asserted
// before forge broadcasts it.
//
// Required env:
//   PRIVATE_KEY                          deployer and initial owner
//   FLOAT_MAINNET_EXPECTED_CHAIN_ID      must equal the RPC's chain id
//   FLOAT_MAINNET_USDC                   six-decimal USDC token
//   FLOAT_MAINNET_MAX_*                  immutable maxima, atomic USDC
//   FLOAT_MAINNET_INIT_*                 initial effective caps, atomic USDC
//   FLOAT_MAINNET_MIN_REPAYMENT_WINDOW   seconds
//   FLOAT_MAINNET_MAX_REPAYMENT_WINDOW   seconds
//   FLOAT_MAINNET_GOVERNANCE_DELAY       seconds
// Optional env:
//   FLOAT_MAINNET_PROPOSED_OWNER         absent, blank, or zero = none
//   FLOAT_MAINNET_EXPECTED_DEPLOYER      absent, blank, or zero = unchecked;
//                                        otherwise PRIVATE_KEY must control it
contract DeployShadowFloatMainnet is Script {
    string constant PROPOSED_OWNER = "FLOAT_MAINNET_PROPOSED_OWNER";
    string constant EXPECTED_DEPLOYER = "FLOAT_MAINNET_EXPECTED_DEPLOYER";

    function run() external returns (address deployed) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 expectedChainId = vm.envUint("FLOAT_MAINNET_EXPECTED_CHAIN_ID");
        address usdc = vm.envAddress("FLOAT_MAINNET_USDC");
        ShadowFloatMainnet.Limits memory maxima = ShadowFloatMainnet.Limits({
            protocolReserve: vm.envUint("FLOAT_MAINNET_MAX_PROTOCOL_RESERVE"),
            lineReserve: vm.envUint("FLOAT_MAINNET_MAX_LINE_RESERVE"),
            lineSpend: vm.envUint("FLOAT_MAINNET_MAX_LINE_SPEND"),
            perSpend: vm.envUint("FLOAT_MAINNET_MAX_PER_SPEND"),
            dailySpend: vm.envUint("FLOAT_MAINNET_MAX_DAILY_SPEND")
        });
        ShadowFloatMainnet.Limits memory initial = ShadowFloatMainnet.Limits({
            protocolReserve: vm.envUint("FLOAT_MAINNET_INIT_PROTOCOL_RESERVE"),
            lineReserve: vm.envUint("FLOAT_MAINNET_INIT_LINE_RESERVE"),
            lineSpend: vm.envUint("FLOAT_MAINNET_INIT_LINE_SPEND"),
            perSpend: vm.envUint("FLOAT_MAINNET_INIT_PER_SPEND"),
            dailySpend: vm.envUint("FLOAT_MAINNET_INIT_DAILY_SPEND")
        });
        uint256 minimumRepaymentWindow = vm.envUint("FLOAT_MAINNET_MIN_REPAYMENT_WINDOW");
        uint256 maximumRepaymentWindow = vm.envUint("FLOAT_MAINNET_MAX_REPAYMENT_WINDOW");
        uint256 governanceDelay = vm.envUint("FLOAT_MAINNET_GOVERNANCE_DELAY");
        // envOr(address) silently defaults on a malformed value, so parse strictly when set.
        address proposedOwner = bytes(VmDeployMainnet(address(vm)).envOr(PROPOSED_OWNER, string(""))).length == 0
            ? address(0)
            : vm.envAddress(PROPOSED_OWNER);
        address expectedDeployer = bytes(VmDeployMainnet(address(vm)).envOr(EXPECTED_DEPLOYER, string(""))).length == 0
            ? address(0)
            : vm.envAddress(EXPECTED_DEPLOYER);
        address deployer = vm.addr(deployerKey);

        require(block.chainid == expectedChainId, "FLOAT_MAINNET_WRONG_CHAIN");
        require(usdc.code.length != 0, "FLOAT_MAINNET_USDC_HAS_NO_CODE");
        require(IERC20(usdc).decimals() == 6, "FLOAT_MAINNET_USDC_NOT_SIX_DECIMALS");
        require(expectedDeployer == address(0) || deployer == expectedDeployer, "FLOAT_MAINNET_UNEXPECTED_DEPLOYER");

        vm.startBroadcast(deployerKey);
        // A truncating uint64 cast is caught by the getter checks below, before forge broadcasts.
        ShadowFloatMainnet float = new ShadowFloatMainnet(
            usdc,
            expectedChainId,
            maxima,
            initial,
            uint64(minimumRepaymentWindow),
            uint64(maximumRepaymentWindow),
            uint64(governanceDelay)
        );
        if (proposedOwner != address(0)) float.proposeOwner(proposedOwner);
        vm.stopBroadcast();

        require(address(float.usdc()) == usdc, "USDC_MISMATCH");
        require(float.deploymentChainId() == expectedChainId, "CHAIN_ID_MISMATCH");
        require(float.maximumProtocolReserve() == maxima.protocolReserve, "MAX_PROTOCOL_RESERVE_MISMATCH");
        require(float.maximumLineReserve() == maxima.lineReserve, "MAX_LINE_RESERVE_MISMATCH");
        require(float.maximumLineSpend() == maxima.lineSpend, "MAX_LINE_SPEND_MISMATCH");
        require(float.maximumPerSpend() == maxima.perSpend, "MAX_PER_SPEND_MISMATCH");
        require(float.maximumDailySpend() == maxima.dailySpend, "MAX_DAILY_SPEND_MISMATCH");
        require(float.minimumRepaymentWindow() == minimumRepaymentWindow, "MIN_REPAYMENT_WINDOW_MISMATCH");
        require(float.maximumRepaymentWindow() == maximumRepaymentWindow, "MAX_REPAYMENT_WINDOW_MISMATCH");
        require(float.governanceDelay() == governanceDelay, "GOVERNANCE_DELAY_MISMATCH");

        (uint256 protocolReserve, uint256 lineReserve, uint256 lineSpend, uint256 perSpend, uint256 dailySpend) =
            float.effectiveLimits();
        require(protocolReserve == initial.protocolReserve, "INIT_PROTOCOL_RESERVE_MISMATCH");
        require(lineReserve == initial.lineReserve, "INIT_LINE_RESERVE_MISMATCH");
        require(lineSpend == initial.lineSpend, "INIT_LINE_SPEND_MISMATCH");
        require(perSpend == initial.perSpend, "INIT_PER_SPEND_MISMATCH");
        require(dailySpend == initial.dailySpend, "INIT_DAILY_SPEND_MISMATCH");

        require(float.owner() == deployer, "OWNER_NOT_DEPLOYER");
        require(float.pendingOwner() == proposedOwner, "PENDING_OWNER_MISMATCH");
        require(!float.operators(deployer), "DEPLOYER_IS_OPERATOR");
        require(!float.openingsPaused() && !float.spendsPaused(), "PAUSED_AT_DEPLOY");
        require(float.totalCommittedCapital() == 0 && float.totalSponsorObligations() == 0, "FUNDED_AT_DEPLOY");

        return address(float);
    }
}
