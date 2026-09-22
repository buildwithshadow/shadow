// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployShadowFloatMainnet} from "../script/DeployShadowFloatMainnet.s.sol";
import {MockAsset} from "../src/MockAsset.sol";
import {ShadowFloatMainnet} from "../src/ShadowFloatMainnet.sol";

interface VmMainnetDeployScript {
    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
    function setEnv(string calldata name, string calldata value) external;
    function stopBroadcast() external;
    function toString(address value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
}

contract ShadowFloatMainnetDeployScriptTest {
    VmMainnetDeployScript private constant vm =
        VmMainnetDeployScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant DEPLOYER_PK = 0xDE9107;
    uint256 private constant ARC_TESTNET_CHAIN_ID = 5042002;
    address private constant NEXT_OWNER = address(0xABCD);
    bytes4 private constant CHEATCODE_ERROR = bytes4(keccak256("CheatcodeError(string)"));

    DeployShadowFloatMainnet private script;
    MockAsset private usdc;
    address private deployer;

    function setUp() public {
        script = new DeployShadowFloatMainnet();
        usdc = new MockAsset("Mock USDC", "USDC", 6);
        deployer = vm.addr(DEPLOYER_PK);
    }

    // setEnv is process-global, forge runs test functions in parallel, and there
    // is no unsetEnv cheatcode, so every env-driven case runs in this one function.
    function testDeployScriptEnvScenarios() public {
        vm.chainId(ARC_TESTNET_CHAIN_ID);
        _setPinnedEnv();

        string[16] memory required = [
            string("PRIVATE_KEY"),
            "FLOAT_MAINNET_EXPECTED_CHAIN_ID",
            "FLOAT_MAINNET_USDC",
            "FLOAT_MAINNET_MAX_PROTOCOL_RESERVE",
            "FLOAT_MAINNET_MAX_LINE_RESERVE",
            "FLOAT_MAINNET_MAX_LINE_SPEND",
            "FLOAT_MAINNET_MAX_PER_SPEND",
            "FLOAT_MAINNET_MAX_DAILY_SPEND",
            "FLOAT_MAINNET_INIT_PROTOCOL_RESERVE",
            "FLOAT_MAINNET_INIT_LINE_RESERVE",
            "FLOAT_MAINNET_INIT_LINE_SPEND",
            "FLOAT_MAINNET_INIT_PER_SPEND",
            "FLOAT_MAINNET_INIT_DAILY_SPEND",
            "FLOAT_MAINNET_MIN_REPAYMENT_WINDOW",
            "FLOAT_MAINNET_MAX_REPAYMENT_WINDOW",
            "FLOAT_MAINNET_GOVERNANCE_DELAY"
        ];
        for (uint256 i; i < required.length; ++i) {
            vm.setEnv(required[i], "");
            _assertTrue(
                bytes4(_runReverts(required[i])) == CHEATCODE_ERROR,
                string.concat("blank env not rejected at read: ", required[i])
            );
            _setPinnedEnv();
        }

        vm.chainId(1);
        _assertRevertData(_runReverts("wrong chain"), _error("FLOAT_MAINNET_WRONG_CHAIN"), "wrong chain guard");
        vm.chainId(ARC_TESTNET_CHAIN_ID);

        vm.setEnv("FLOAT_MAINNET_USDC", vm.toString(address(0xdEaD)));
        _assertRevertData(_runReverts("codeless usdc"), _error("FLOAT_MAINNET_USDC_HAS_NO_CODE"), "code guard");

        MockAsset wrongDecimals = new MockAsset("Wrong", "WRONG", 18);
        vm.setEnv("FLOAT_MAINNET_USDC", vm.toString(address(wrongDecimals)));
        _assertRevertData(
            _runReverts("18-decimal usdc"), _error("FLOAT_MAINNET_USDC_NOT_SIX_DECIMALS"), "decimals guard"
        );
        vm.setEnv("FLOAT_MAINNET_USDC", vm.toString(address(usdc)));

        vm.setEnv("FLOAT_MAINNET_MAX_PER_SPEND", "10000001");
        _assertRevertData(
            _runReverts("perSpend above lineReserve"),
            abi.encodeWithSelector(ShadowFloatMainnet.InvalidConfiguration.selector),
            "limits guard"
        );
        // The constructor reverted inside the script's broadcast, which a revert does not end.
        vm.stopBroadcast();
        vm.setEnv("FLOAT_MAINNET_MAX_PER_SPEND", "2000000");

        vm.setEnv("FLOAT_MAINNET_GOVERNANCE_DELAY", "18446744073709724416");
        _assertRevertData(
            _runReverts("governance delay above uint64"), _error("GOVERNANCE_DELAY_MISMATCH"), "uint64 truncation"
        );
        vm.setEnv("FLOAT_MAINNET_GOVERNANCE_DELAY", "172800");

        vm.setEnv("FLOAT_MAINNET_MIN_REPAYMENT_WINDOW", "18446744073709555216");
        _assertRevertData(
            _runReverts("minimum repayment window above uint64"),
            _error("MIN_REPAYMENT_WINDOW_MISMATCH"),
            "minimum window uint64 truncation"
        );
        vm.setEnv("FLOAT_MAINNET_MIN_REPAYMENT_WINDOW", "3600");

        vm.setEnv("FLOAT_MAINNET_MAX_REPAYMENT_WINDOW", "18446744073710156416");
        _assertRevertData(
            _runReverts("maximum repayment window above uint64"),
            _error("MAX_REPAYMENT_WINDOW_MISMATCH"),
            "maximum window uint64 truncation"
        );
        vm.setEnv("FLOAT_MAINNET_MAX_REPAYMENT_WINDOW", "604800");

        vm.setEnv("FLOAT_MAINNET_EXPECTED_DEPLOYER", vm.toString(NEXT_OWNER));
        _assertRevertData(
            _runReverts("unexpected deployer"), _error("FLOAT_MAINNET_UNEXPECTED_DEPLOYER"), "deployer guard"
        );
        vm.setEnv("FLOAT_MAINNET_EXPECTED_DEPLOYER", "0xDE91notAnAddress");
        _assertTrue(
            bytes4(_runReverts("malformed expected deployer")) == CHEATCODE_ERROR, "malformed deployer defaulted"
        );
        vm.setEnv("FLOAT_MAINNET_EXPECTED_DEPLOYER", vm.toString(deployer));
        _assertDeployed(ShadowFloatMainnet(script.run()), address(0));
        vm.setEnv("FLOAT_MAINNET_EXPECTED_DEPLOYER", "0x0000000000000000000000000000000000000000");
        _assertDeployed(ShadowFloatMainnet(script.run()), address(0));
        vm.setEnv("FLOAT_MAINNET_EXPECTED_DEPLOYER", "");

        _assertDeployed(ShadowFloatMainnet(script.run()), address(0));

        vm.setEnv("FLOAT_MAINNET_PROPOSED_OWNER", vm.toString(NEXT_OWNER));
        _assertDeployed(ShadowFloatMainnet(script.run()), NEXT_OWNER);

        vm.setEnv("FLOAT_MAINNET_PROPOSED_OWNER", "0x0000000000000000000000000000000000000000");
        _assertDeployed(ShadowFloatMainnet(script.run()), address(0));

        vm.setEnv("FLOAT_MAINNET_PROPOSED_OWNER", "0xABCDnotAnAddress");
        _assertTrue(bytes4(_runReverts("malformed proposed owner")) == CHEATCODE_ERROR, "malformed owner defaulted");
    }

    function _setPinnedEnv() private {
        vm.setEnv("PRIVATE_KEY", vm.toString(DEPLOYER_PK));
        vm.setEnv("FLOAT_MAINNET_EXPECTED_CHAIN_ID", "5042002");
        vm.setEnv("FLOAT_MAINNET_USDC", vm.toString(address(usdc)));
        vm.setEnv("FLOAT_MAINNET_MAX_PROTOCOL_RESERVE", "50000000");
        vm.setEnv("FLOAT_MAINNET_MAX_LINE_RESERVE", "10000000");
        vm.setEnv("FLOAT_MAINNET_MAX_LINE_SPEND", "10000000");
        vm.setEnv("FLOAT_MAINNET_MAX_PER_SPEND", "2000000");
        vm.setEnv("FLOAT_MAINNET_MAX_DAILY_SPEND", "4000000");
        vm.setEnv("FLOAT_MAINNET_INIT_PROTOCOL_RESERVE", "25000000");
        vm.setEnv("FLOAT_MAINNET_INIT_LINE_RESERVE", "5000000");
        vm.setEnv("FLOAT_MAINNET_INIT_LINE_SPEND", "5000000");
        vm.setEnv("FLOAT_MAINNET_INIT_PER_SPEND", "1000000");
        vm.setEnv("FLOAT_MAINNET_INIT_DAILY_SPEND", "2000000");
        vm.setEnv("FLOAT_MAINNET_MIN_REPAYMENT_WINDOW", "3600");
        vm.setEnv("FLOAT_MAINNET_MAX_REPAYMENT_WINDOW", "604800");
        vm.setEnv("FLOAT_MAINNET_GOVERNANCE_DELAY", "172800");
        vm.setEnv("FLOAT_MAINNET_PROPOSED_OWNER", "");
        vm.setEnv("FLOAT_MAINNET_EXPECTED_DEPLOYER", "");
    }

    function _runReverts(string memory scenario) private returns (bytes memory reason) {
        try script.run() returns (address) {
            revert(string.concat("deploy script accepted: ", scenario));
        } catch (bytes memory data) {
            return data;
        }
    }

    function _assertDeployed(ShadowFloatMainnet float, address expectedPendingOwner) private view {
        _assertTrue(address(float).code.length != 0, "nothing deployed");
        _assertTrue(address(float.usdc()) == address(usdc), "wrong usdc");
        _assertEq(float.deploymentChainId(), ARC_TESTNET_CHAIN_ID, "wrong chain id");
        _assertEq(float.maximumProtocolReserve(), 50_000_000, "wrong protocol maximum");
        _assertEq(float.maximumLineReserve(), 10_000_000, "wrong line maximum");
        _assertEq(float.maximumLineSpend(), 10_000_000, "wrong line-spend maximum");
        _assertEq(float.maximumPerSpend(), 2_000_000, "wrong per-spend maximum");
        _assertEq(float.maximumDailySpend(), 4_000_000, "wrong daily maximum");
        _assertEq(float.minimumRepaymentWindow(), 3600, "wrong minimum repayment window");
        _assertEq(float.maximumRepaymentWindow(), 604_800, "wrong maximum repayment window");
        _assertEq(float.governanceDelay(), 172_800, "wrong governance delay");

        (uint256 protocolReserve, uint256 lineReserve, uint256 lineSpend, uint256 perSpend, uint256 dailySpend) =
            float.effectiveLimits();
        _assertEq(protocolReserve, 25_000_000, "wrong effective protocol reserve");
        _assertEq(lineReserve, 5_000_000, "wrong effective line reserve");
        _assertEq(lineSpend, 5_000_000, "wrong effective line spend");
        _assertEq(perSpend, 1_000_000, "wrong effective per spend");
        _assertEq(dailySpend, 2_000_000, "wrong effective daily spend");

        _assertTrue(float.owner() == deployer, "owner is not deployer");
        _assertTrue(float.pendingOwner() == expectedPendingOwner, "wrong pending owner");
        _assertTrue(!float.operators(deployer), "deployer is operator");
        _assertTrue(!float.openingsPaused(), "openings paused");
        _assertTrue(!float.spendsPaused(), "spends paused");
        _assertEq(float.totalCommittedCapital(), 0, "capital committed at deploy");
        _assertEq(float.totalSponsorObligations(), 0, "obligations at deploy");
    }

    function _error(string memory message) private pure returns (bytes memory) {
        return abi.encodeWithSignature("Error(string)", message);
    }

    function _assertRevertData(bytes memory actual, bytes memory expected, string memory message) private pure {
        _assertTrue(keccak256(actual) == keccak256(expected), message);
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory message) private pure {
        require(actual == expected, message);
    }
}
