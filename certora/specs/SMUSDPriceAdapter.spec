/// @title SMUSDPriceAdapter Formal Verification Spec
/// @notice Verifies governance-only parameter updates and bound invariants.

methods {
    function DECIMALS() external returns (uint8) envfree;
    function minSharePrice() external returns (uint256) envfree;
    function maxSharePrice() external returns (uint256) envfree;
    function minTotalSupply() external returns (uint256) envfree;
    function maxPriceChangePerBlock() external returns (uint256) envfree;

    function ADAPTER_ADMIN_ROLE() external returns (bytes32) envfree;
    function TIMELOCK_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function setSharePriceBounds(uint256, uint256) external;
    function setDonationProtection(uint256, uint256) external;
    function incrementRound() external;
}

invariant share_price_bounds_are_well_formed()
    minSharePrice() > 0 && maxSharePrice() > minSharePrice() && maxSharePrice() <= 1000000000;

invariant donation_protection_bounds_are_well_formed()
    minTotalSupply() > 0 && maxPriceChangePerBlock() > 0 && maxPriceChangePerBlock() <= 50000000;

rule decimals_constant_is_8() {
    assert DECIMALS() == 8,
        "Adapter decimals constant must remain 8";
}

rule set_share_price_bounds_requires_timelock(uint256 minPrice, uint256 maxPrice) {
    env e;
    setSharePriceBounds@withrevert(e, minPrice, maxPrice);

    assert !lastReverted => hasRole(TIMELOCK_ROLE(), e.msg.sender),
        "setSharePriceBounds must be timelock-gated";
}

rule set_donation_protection_requires_timelock(uint256 minSupply, uint256 maxChange) {
    env e;
    setDonationProtection@withrevert(e, minSupply, maxChange);

    assert !lastReverted => hasRole(TIMELOCK_ROLE(), e.msg.sender),
        "setDonationProtection must be timelock-gated";
}

rule increment_round_requires_adapter_admin() {
    env e;
    incrementRound@withrevert(e);

    assert !lastReverted => hasRole(ADAPTER_ADMIN_ROLE(), e.msg.sender),
        "incrementRound must be adapter-admin-gated";
}
