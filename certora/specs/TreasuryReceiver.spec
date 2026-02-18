/// @title TreasuryReceiver Formal Verification Spec
/// @notice Verifies emergency controls and role-gated administrative paths.

methods {
    function paused() external returns (bool) envfree;
    function PAUSER_ROLE() external returns (bytes32) envfree;
    function DEFAULT_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function pause() external;
    function emergencyWithdraw(address, address, uint256) external;
}

rule pause_requires_pauser() {
    env e;
    pause@withrevert(e);
    assert !lastReverted => hasRole(PAUSER_ROLE(), e.msg.sender),
        "pause must be PAUSER_ROLE-gated";
}

rule emergency_withdraw_requires_admin(address token, address to, uint256 amount) {
    env e;
    emergencyWithdraw@withrevert(e, token, to, amount);
    assert !lastReverted => hasRole(DEFAULT_ADMIN_ROLE(), e.msg.sender),
        "emergencyWithdraw must be DEFAULT_ADMIN_ROLE-gated";
}

rule emergency_withdraw_requires_paused(address token, address to, uint256 amount) {
    env e;
    require !paused();
    emergencyWithdraw@withrevert(e, token, to, amount);
    assert lastReverted, "emergencyWithdraw must revert when contract is not paused";
}
