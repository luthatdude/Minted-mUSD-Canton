/// @title YieldScanner Formal Verification Spec
/// @notice Verifies manager-only configuration paths for scanner state.

methods {
    function MANAGER_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;
    function entryCount() external returns (uint256) envfree;

    function aaveV3Pool() external returns (address) envfree;
    function compoundComet() external returns (address) envfree;
    function morphoBlue() external returns (address) envfree;
    function morphoRegistry() external returns (address) envfree;

    function configureAaveV3(address) external;
    function configureCompoundV3(address) external;
    function configureMorpho(address, address) external;
    function toggleEntry(uint256, bool) external;
}

rule configure_aave_requires_manager(address pool) {
    env e;
    configureAaveV3@withrevert(e, pool);
    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "configureAaveV3 must be MANAGER_ROLE-gated";
}

rule configure_compound_requires_manager(address comet) {
    env e;
    configureCompoundV3@withrevert(e, comet);
    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "configureCompoundV3 must be MANAGER_ROLE-gated";
}

rule configure_morpho_requires_manager(address blue, address registry) {
    env e;
    configureMorpho@withrevert(e, blue, registry);
    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "configureMorpho must be MANAGER_ROLE-gated";
}

rule toggle_entry_requires_manager(uint256 index, bool enabled) {
    env e;
    toggleEntry@withrevert(e, index, enabled);
    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "toggleEntry must be MANAGER_ROLE-gated";
}

rule configure_aave_stores_on_success(address pool) {
    env e;
    configureAaveV3@withrevert(e, pool);
    bool succeeded = !lastReverted;
    assert succeeded => aaveV3Pool() == pool,
        "configureAaveV3 must store the configured pool on success";
}
