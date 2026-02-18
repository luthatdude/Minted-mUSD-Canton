/// @title SMUSDE Formal Verification Spec
/// @notice Verifies pool-gated mint/burn, compliance controls, and pause roles.

methods {
    function totalSupply() external returns (uint256) envfree;
    function balanceOf(address) external returns (uint256) envfree;
    function paused() external returns (bool) envfree;
    function isBlacklisted(address) external returns (bool) envfree;

    function POOL_ROLE() external returns (bytes32) envfree;
    function COMPLIANCE_ROLE() external returns (bytes32) envfree;
    function PAUSER_ROLE() external returns (bytes32) envfree;
    function DEFAULT_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function mint(address, uint256) external;
    function burn(address, uint256) external;
    function setBlacklist(address, bool) external;
    function transfer(address, uint256) external;
    function pause() external;
    function unpause() external;
}

rule mint_requires_pool_role(address to, uint256 amount) {
    env e;
    mint@withrevert(e, to, amount);

    assert !lastReverted => hasRole(POOL_ROLE(), e.msg.sender),
        "mint must be POOL_ROLE-gated";
}

rule burn_requires_pool_role(address from, uint256 amount) {
    env e;
    burn@withrevert(e, from, amount);

    assert !lastReverted => hasRole(POOL_ROLE(), e.msg.sender),
        "burn must be POOL_ROLE-gated";
}

rule set_blacklist_requires_compliance(address account, bool status) {
    env e;
    setBlacklist@withrevert(e, account, status);

    assert !lastReverted => hasRole(COMPLIANCE_ROLE(), e.msg.sender),
        "setBlacklist must be COMPLIANCE_ROLE-gated";
}

rule pause_requires_pauser_role() {
    env e;
    pause@withrevert(e);

    assert !lastReverted => hasRole(PAUSER_ROLE(), e.msg.sender),
        "pause must be PAUSER_ROLE-gated";
}

rule unpause_requires_admin_role() {
    env e;
    unpause@withrevert(e);

    assert !lastReverted => hasRole(DEFAULT_ADMIN_ROLE(), e.msg.sender),
        "unpause must be DEFAULT_ADMIN_ROLE-gated";
}

rule blacklisted_sender_cannot_transfer(address to, uint256 amount) {
    env e;
    require isBlacklisted(e.msg.sender);

    transfer@withrevert(e, to, amount);

    assert lastReverted,
        "Transfers from blacklisted sender must revert";
}

rule transfer_reverts_when_paused(address to, uint256 amount) {
    env e;
    require paused();

    transfer@withrevert(e, to, amount);

    assert lastReverted,
        "transfer must revert while paused";
}
