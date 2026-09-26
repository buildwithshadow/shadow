// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockAsset} from "../src/MockAsset.sol";

// Deliberately minimal LOCAL TEST fixtures. These are not Safe implementations
// or deployable production components; tests pin their distinct runtime hashes.
contract ActivationTokenFixture is MockAsset {
    bool public paused;
    mapping(address => bool) public isBlacklisted;
    constructor() MockAsset("USD Coin", "USDC", 6) {}
    function restrict(address account, bool value) external { isBlacklisted[account] = value; }
}

contract ActivationSingletonFixture { function marker() external pure returns (uint256) { return 1; } }

contract ActivationSafeFixture {
    address public immutable masterCopy;
    address private signer;
    constructor(address singleton, address owner) { masterCopy = singleton; signer = owner; }
    function VERSION() external pure returns (string memory) { return "1.5.0"; }
    function getOwners() external view returns (address[] memory owners) { owners = new address[](1); owners[0] = signer; }
    function getThreshold() external pure returns (uint256) { return 1; }
    function getModulesPaginated(address, uint256) external pure returns (address[] memory modules, address next) {
        modules = new address[](0); next = address(1);
    }
    function getStorageAt(uint256, uint256) external pure returns (bytes memory) { return new bytes(32); }
    function execute(address target, bytes calldata data) external {
        require(msg.sender == signer, "test signer");
        (bool ok, ) = target.call(data); require(ok, "test call failed");
    }
}
