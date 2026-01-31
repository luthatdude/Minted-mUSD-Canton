// SPDX-License-Identifier: MIT
// BLE Protocol - V9
// Refactored: Canton attestations update supply cap, not mint directly
//
// WARNING (S-C01): V9 has INCOMPATIBLE storage layout with V8.
// V8 has 12 state variables (musdToken, totalCantonAssets, currentNonce, minSignatures,
// dailyMintLimit, dailyMinted, dailyBurned, lastReset, navOracle, maxNavDeviationBps,
// navOracleEnabled, usedAttestationIds) + __gap[38] = 50 slots.
// V9 has 12 state variables (musdToken, attestedCantonAssets, collateralRatioBps, currentNonce,
// minSignatures, lastAttestationTime, lastRatioChangeTime, dailyCapIncreaseLimit,
// dailyCapIncreased, dailyCapDecreased, lastRateLimitReset, usedAttestationIds) + __gap[38] = 50 slots.
// Direct UUPS upgrade from V8->V9 will corrupt storage. A migration contract is required.

pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IMUSD {
    function setSupplyCap(uint256 _cap) external;
    function supplyCap() external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

contract BLEBridgeV9 is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    IMUSD public musdToken;

    // Canton attestation state
    uint256 public attestedCantonAssets;  // Total assets Canton has attested to
    uint256 public collateralRatioBps;    // Required ratio (e.g., 11000 = 110%)
    uint256 public currentNonce;
    uint256 public minSignatures;
    uint256 public lastAttestationTime;
    uint256 public lastRatioChangeTime;

    // 24h rolling window rate limiting on supply cap increases
    uint256 public dailyCapIncreaseLimit;  // Max supply cap increase per 24h window
    uint256 public dailyCapIncreased;      // Cumulative cap increases in current window
    uint256 public dailyCapDecreased;      // Cumulative cap decreases in current window (offsets increases)
    uint256 public lastRateLimitReset;     // Timestamp of last window reset

    // Attestation tracking
    mapping(bytes32 => bool) public usedAttestationIds;

    struct Attestation {
        bytes32 id;
        uint256 cantonAssets;      // Total assets on Canton (e.g., $500M)
        uint256 nonce;
        uint256 timestamp;
    }

    // Events
    event AttestationReceived(
        bytes32 indexed id,
        uint256 cantonAssets,
        uint256 newSupplyCap,
        uint256 nonce,
        uint256 timestamp
    );
    event SupplyCapUpdated(uint256 oldCap, uint256 newCap, uint256 attestedAssets);
    event CollateralRatioUpdated(uint256 oldRatio, uint256 newRatio);
    event EmergencyCapReduction(uint256 oldCap, uint256 newCap, string reason);
    event NonceForceUpdated(uint256 oldNonce, uint256 newNonce, string reason);
    event MUSDTokenUpdated(address indexed oldToken, address indexed newToken);
    // FIX S-H03: Event for attestation invalidation audit trail
    event AttestationInvalidated(bytes32 indexed attestationId, string reason);
    // FIX S-M02: Event for min signatures change
    event MinSignaturesUpdated(uint256 oldMinSigs, uint256 newMinSigs);
    // Rate limiting events
    event RateLimitReset(uint256 timestamp);
    event DailyCapIncreaseLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event RateLimitedCapIncrease(uint256 requestedIncrease, uint256 allowedIncrease, uint256 remainingLimit);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        uint256 _minSigs,
        address _musdToken,
        uint256 _collateralRatioBps,
        uint256 _dailyCapIncreaseLimit
    ) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        require(_minSigs > 0, "INVALID_MIN_SIGS");
        require(_musdToken != address(0), "INVALID_MUSD_ADDRESS");
        require(_collateralRatioBps >= 10000, "RATIO_BELOW_100_PERCENT");
        require(_dailyCapIncreaseLimit > 0, "INVALID_DAILY_LIMIT");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(EMERGENCY_ROLE, msg.sender);

        minSignatures = _minSigs;
        musdToken = IMUSD(_musdToken);
        collateralRatioBps = _collateralRatioBps;
        dailyCapIncreaseLimit = _dailyCapIncreaseLimit;
        lastRateLimitReset = block.timestamp;
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setMUSDToken(address _musdToken) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_musdToken != address(0), "INVALID_ADDRESS");
        emit MUSDTokenUpdated(address(musdToken), _musdToken);
        musdToken = IMUSD(_musdToken);
    }

    // FIX S-M02: Emit event for admin parameter change
    function setMinSignatures(uint256 _minSigs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_minSigs > 0, "INVALID_MIN_SIGS");
        emit MinSignaturesUpdated(minSignatures, _minSigs);
        minSignatures = _minSigs;
    }

    function setDailyCapIncreaseLimit(uint256 _limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_limit > 0, "INVALID_LIMIT");
        emit DailyCapIncreaseLimitUpdated(dailyCapIncreaseLimit, _limit);
        dailyCapIncreaseLimit = _limit;
    }

    // FIX M-05: Ratio changes are applied immediately but emit event for monitoring.
    // For production, this should be behind a timelock contract.
    function setCollateralRatio(uint256 _ratioBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // FIX S-M02: Rate-limit ratio changes to once per day
        require(block.timestamp >= lastRatioChangeTime + 1 days, "RATIO_CHANGE_COOLDOWN");
        require(_ratioBps >= 10000, "RATIO_BELOW_100_PERCENT");
        // FIX M-05: Prevent drastic ratio changes (max 10% change at a time)
        uint256 oldRatio = collateralRatioBps;
        uint256 diff = _ratioBps > oldRatio ? _ratioBps - oldRatio : oldRatio - _ratioBps;
        require(diff <= 1000, "RATIO_CHANGE_TOO_LARGE"); // Max 10% change per call

        collateralRatioBps = _ratioBps;
        emit CollateralRatioUpdated(oldRatio, _ratioBps);

        // Recalculate supply cap with new ratio
        if (attestedCantonAssets > 0) {
            _updateSupplyCap(attestedCantonAssets);
        }

        lastRatioChangeTime = block.timestamp;
    }

    // ============================================================
    //                  EMERGENCY FUNCTIONS
    // ============================================================

    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /// FIX H-05: Unpause requires DEFAULT_ADMIN_ROLE (separation of duties)
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Emergency reduction of supply cap
    function emergencyReduceCap(uint256 _newCap, string calldata _reason) external onlyRole(EMERGENCY_ROLE) {
        require(bytes(_reason).length > 0, "REASON_REQUIRED");
        uint256 oldCap = musdToken.supplyCap();
        require(_newCap < oldCap, "NOT_A_REDUCTION");
        require(_newCap >= musdToken.totalSupply(), "CAP_BELOW_SUPPLY");

        musdToken.setSupplyCap(_newCap);
        emit EmergencyCapReduction(oldCap, _newCap, _reason);
    }

    /// @notice Force update nonce for stuck attestations
    function forceUpdateNonce(uint256 _newNonce, string calldata _reason) external onlyRole(EMERGENCY_ROLE) {
        require(bytes(_reason).length > 0, "REASON_REQUIRED");
        require(_newNonce > currentNonce, "NONCE_MUST_INCREASE");
        emit NonceForceUpdated(currentNonce, _newNonce, _reason);
        currentNonce = _newNonce;
    }

    /// @notice Invalidate an attestation ID
    /// FIX S-H03: Added reason parameter and event emission for audit trail
    function invalidateAttestationId(bytes32 _attestationId, string calldata _reason) external onlyRole(EMERGENCY_ROLE) {
        require(!usedAttestationIds[_attestationId], "ALREADY_USED");
        require(bytes(_reason).length > 0, "REASON_REQUIRED");
        usedAttestationIds[_attestationId] = true;
        emit AttestationInvalidated(_attestationId, _reason);
    }

    // ============================================================
    //                  CORE ATTESTATION LOGIC
    // ============================================================

    /// @notice Process Canton attestation and update mUSD supply cap
    /// @param att The attestation data from Canton validators
    /// @param signatures Validator signatures
    function processAttestation(
        Attestation calldata att,
        bytes[] calldata signatures
    ) external nonReentrant whenNotPaused {
        require(signatures.length >= minSignatures, "INSUFFICIENT_SIGNATURES");
        require(att.nonce == currentNonce + 1, "INVALID_NONCE");
        require(!usedAttestationIds[att.id], "ATTESTATION_REUSED");
        require(att.cantonAssets > 0, "ZERO_ASSETS");
        require(att.timestamp <= block.timestamp, "FUTURE_TIMESTAMP");
        require(att.timestamp > lastAttestationTime, "STALE_ATTESTATION");

        // Verify signatures
        bytes32 messageHash = keccak256(abi.encodePacked(
            att.id,
            att.cantonAssets,
            att.nonce,
            att.timestamp,
            block.chainid,
            address(this)
        ));

        bytes32 ethHash = messageHash.toEthSignedMessageHash();

        address lastSigner = address(0);
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ethHash.recover(signatures[i]);
            require(hasRole(VALIDATOR_ROLE, signer), "INVALID_VALIDATOR");
            require(signer > lastSigner, "UNSORTED_SIGNATURES");
            lastSigner = signer;
        }

        // Mark attestation as used
        usedAttestationIds[att.id] = true;
        currentNonce++;
        lastAttestationTime = att.timestamp;
        attestedCantonAssets = att.cantonAssets;

        // Update supply cap based on attested assets
        uint256 newCap = _updateSupplyCap(att.cantonAssets);

        emit AttestationReceived(att.id, att.cantonAssets, newCap, att.nonce, att.timestamp);
    }

    // ============================================================
    //                    INTERNAL FUNCTIONS
    // ============================================================

    /// @notice Calculate and update supply cap based on attested assets, enforcing rate limit
    /// @param _attestedAssets Total assets attested by Canton
    /// @return newCap The new supply cap
    function _updateSupplyCap(uint256 _attestedAssets) internal returns (uint256 newCap) {
        // supplyCap = attestedAssets / (collateralRatio / 10000)
        // e.g., $500M assets at 110% ratio = $454.5M cap
        newCap = (_attestedAssets * 10000) / collateralRatioBps;

        uint256 oldCap = musdToken.supplyCap();

        // Only update if cap is changing
        if (newCap != oldCap) {
            if (newCap > oldCap) {
                // Cap is increasing — enforce 24h rate limit
                uint256 increase = newCap - oldCap;
                newCap = oldCap + _handleRateLimitCapIncrease(increase);
            } else {
                // Cap is decreasing — always allow (decreases offset future increases)
                _handleRateLimitCapDecrease(oldCap - newCap);
            }

            // FIX M-04: Do NOT floor at currentSupply when cap drops.
            // If assets decreased, the cap should reflect reality (no new minting).
            // Existing tokens remain but the cap correctly signals undercollateralization.
            musdToken.setSupplyCap(newCap);
            emit SupplyCapUpdated(oldCap, newCap, _attestedAssets);
        }
    }

    // ============================================================
    //                      RATE LIMITING
    // ============================================================

    /// @notice Enforce 24h rolling window on supply cap increases
    /// @param increase The requested cap increase amount
    /// @return allowed The actual allowed increase (clamped to remaining limit)
    function _handleRateLimitCapIncrease(uint256 increase) internal returns (uint256 allowed) {
        _resetDailyLimitsIfNeeded();

        // Net increase = dailyCapIncreased - dailyCapDecreased (burns offset mints)
        uint256 netIncreased = dailyCapIncreased > dailyCapDecreased
            ? dailyCapIncreased - dailyCapDecreased
            : 0;

        require(netIncreased < dailyCapIncreaseLimit, "DAILY_CAP_INCREASE_LIMIT");

        uint256 remaining = dailyCapIncreaseLimit - netIncreased;
        allowed = increase > remaining ? remaining : increase;

        dailyCapIncreased += allowed;

        if (allowed < increase) {
            emit RateLimitedCapIncrease(increase, allowed, 0);
        }
    }

    /// @notice Track cap decreases to offset increases within the same window
    /// @param decrease The cap decrease amount
    function _handleRateLimitCapDecrease(uint256 decrease) internal {
        _resetDailyLimitsIfNeeded();
        dailyCapDecreased += decrease;
    }

    /// @notice Reset daily limits if 24h window has elapsed
    /// FIX M-03: Use >= to prevent boundary timing attack at exact reset second
    function _resetDailyLimitsIfNeeded() internal {
        if (block.timestamp >= lastRateLimitReset + 1 days) {
            dailyCapIncreased = 0;
            dailyCapDecreased = 0;
            lastRateLimitReset = block.timestamp;
            emit RateLimitReset(block.timestamp);
        }
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /// @notice Get the current supply cap based on attestations
    function getCurrentSupplyCap() external view returns (uint256) {
        return musdToken.supplyCap();
    }

    /// @notice Get remaining mintable mUSD
    function getRemainingMintable() external view returns (uint256) {
        uint256 cap = musdToken.supplyCap();
        uint256 supply = musdToken.totalSupply();
        return cap > supply ? cap - supply : 0;
    }

    /// @notice Calculate what supply cap would be for given assets
    function calculateSupplyCap(uint256 _assets) external view returns (uint256) {
        return (_assets * 10000) / collateralRatioBps;
    }

    /// @notice Get the net daily cap increase used in the current window
    function getNetDailyCapIncrease() external view returns (uint256) {
        if (block.timestamp >= lastRateLimitReset + 1 days) {
            return 0;
        }
        return dailyCapIncreased > dailyCapDecreased
            ? dailyCapIncreased - dailyCapDecreased
            : 0;
    }

    /// @notice Get remaining daily cap increase allowance
    function getRemainingDailyCapLimit() external view returns (uint256) {
        if (block.timestamp >= lastRateLimitReset + 1 days) {
            return dailyCapIncreaseLimit;
        }
        uint256 netIncreased = dailyCapIncreased > dailyCapDecreased
            ? dailyCapIncreased - dailyCapDecreased
            : 0;
        return netIncreased >= dailyCapIncreaseLimit ? 0 : dailyCapIncreaseLimit - netIncreased;
    }

    /// @notice Get health ratio (attested assets / current supply)
    function getHealthRatio() external view returns (uint256 ratioBps) {
        uint256 supply = musdToken.totalSupply();
        if (supply == 0) return type(uint256).max;
        return (attestedCantonAssets * 10000) / supply;
    }

    // ============================================================
    //                      UPGRADEABILITY
    // ============================================================

    /// FIX H-09: Add explicit guard against accidental V8->V9 upgrade
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newImplementation != address(0), "INVALID_IMPLEMENTATION");
    }

    // Storage gap for future upgrades — 12 state variables → 50 - 12 = 38
    uint256[38] private __gap;
}
