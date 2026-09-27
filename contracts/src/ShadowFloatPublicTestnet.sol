// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShadowFloatMainnet} from "./ShadowFloatMainnet.sol";

/// @notice Self-service sponsor admission for Arc TESTNET only.
/// Users fund their own lines. Admission grants no access to another sponsor's funds.
/// The existing owner can pause openings and explicitly revoke admission.
contract ShadowFloatPublicTestnet is ShadowFloatMainnet {
    mapping(address => bool) public sponsorAdmissionRevoked;

    constructor(
        address usdc_,
        Limits memory maxima_,
        Limits memory initial_,
        uint64 minimumRepaymentWindow_,
        uint64 maximumRepaymentWindow_,
        uint64 governanceDelay_
    )
        ShadowFloatMainnet(
            usdc_, 5042002, maxima_, initial_, minimumRepaymentWindow_, maximumRepaymentWindow_, governanceDelay_
        )
    {}

    function registerSponsor() external nonReentrant {
        if (openingsPaused) revert InvalidState();
        if (sponsorAdmissionRevoked[msg.sender]) revert Unauthorized();
        if (!sponsorAllowed[msg.sender]) {
            sponsorAllowed[msg.sender] = true;
            emit SponsorAllowed(msg.sender, true);
        }
    }

    function setSponsorAllowed(address sponsor, bool allowed) public override {
        super.setSponsorAllowed(sponsor, allowed);
        sponsorAdmissionRevoked[sponsor] = !allowed;
    }
}
