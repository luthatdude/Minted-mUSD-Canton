// SPDX-License-Identifier: MIT
// BLE Protocol - Production Ready Version
// Fixes: B-01 (Missing mint/burn), B-02 (Chain replay), B-03 (Rate limit bypass),
//        B-04 (Storage gap), B-05 (Attestation ID uniqueness)
// Additions: NAV Oracle check, Emergency nonce recovery

pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IMUSD {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/// @notice Chainlink-compatible price feed interface
interface IAggregatorV3 {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

contract BLEBridgeV8 is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    // Core state
    IMUSD public musdToken;
    uint256 public totalCantonAssets;
    uint256 public currentNonce;
    uint256 public minSignatures;

    // Rate limiting
    uint256 public dailyMintLimit;
    uint256 public dailyMinted;
    uint256 public dailyBurned;
    uint256 public lastReset;

    // NAV Oracle (optional)
    IAggregatorV3 public navOracle;
    uint256 public maxNavDeviationBps;  // Max deviation in basis points (e.g., 500 = 5%)
    bool public navOracleEnabled;

    // Attestation tracking
    mapping(bytes32 => bool) public usedAttestationIds;

    struct Attestation {
        bytes32 id;
        uint256 globalCantonAssets;
        address target;
        uint256 amount;
        bool isMint;
        uint256 nonce;
    }

    // Events
    event AttestationExecuted(
        bytes32 indexed id,
        address indexed target,
        uint256 amount,
        bool isMint,
        uint256 nonce
    );
    event RateLimitReset(uint256 timestamp);
    event MUSDTokenUpdated(address indexed oldToken, address indexed newToken);
    event NonceForceUpdated(uint256 oldNonce, uint256 newNonce, string reason);
    event NavOracleUpdated(address indexed oracle, uint256 maxDeviationBps, bool enabled);
    event EmergencyPause(address indexed triggeredBy, string reason);
    event AttestationInvalidated(bytes32 indexed id, string reason);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(uint256 _minSigs, uint256 _limit, address _musdToken) public initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        require(_minSigs > 0, "INVALID_MIN_SIGS");
        require(_limit > 0, "INVALID_LIMIT");
        require(_musdToken != address(0), "INVALID_MUSD_ADDRESS");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(EMERGENCY_ROLE, msg.sender);

        minSignatures = _minSigs;
        dailyMintLimit = _limit;
        lastReset = block.timestamp;
        musdToken = IMUSD(_musdToken);

        // NAV oracle disabled by default
        navOracleEnabled = false;
        maxNavDeviationBps = 500; // 5% default
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setMUSDToken(address _musdToken) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_musdToken != address(0), "INVALID_ADDRESS");
        address oldToken = address(musdToken);
        musdToken = IMUSD(_musdToken);
        emit MUSDTokenUpdated(oldToken, _musdToken);
    }

    function setMinSignatures(uint256 _minSigs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_minSigs > 0, "INVALID_MIN_SIGS");
        minSignatures = _minSigs;
    }

    function setDailyMintLimit(uint256 _limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_limit > 0, "INVALID_LIMIT");
        dailyMintLimit = _limit;
    }

    /// @notice Configure the NAV oracle for external collateral verification
    /// @param _oracle Chainlink-compatible price feed address (or address(0) to disable)
    /// @param _maxDeviationBps Maximum allowed deviation in basis points (e.g., 500 = 5%)
    /// @param _enabled Whether to enable NAV oracle checks
    function setNavOracle(
        address _oracle,
        uint256 _maxDeviationBps,
        bool _enabled
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // FIX H-06: Cap to 50% - 100% deviation makes NAV oracle useless
        require(_maxDeviationBps <= 5000, "DEVIATION_TOO_HIGH"); // Max 50%
        if (_enabled) {
            require(_oracle != address(0), "INVALID_ORACLE");
        }
        navOracle = IAggregatorV3(_oracle);
        maxNavDeviationBps = _maxDeviationBps;
        navOracleEnabled = _enabled;
        emit NavOracleUpdated(_oracle, _maxDeviationBps, _enabled);
    }

    // ============================================================
    //                  EMERGENCY FUNCTIONS
    // ============================================================

    /// @notice Pause all attestation execution
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /// @notice Resume attestation execution
    /// FIX M-02: Unpause requires DEFAULT_ADMIN_ROLE (separation of duties)
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Force update the nonce in case of stuck transactions
    /// @dev Restricted to EMERGENCY_ROLE (should be a Timelock/Gnosis Safe)
    /// @param _newNonce The new nonce value to set
    /// @param _reason Human-readable reason for the update (for audit trail)
    function forceUpdateNonce(
        uint256 _newNonce,
        string calldata _reason
    ) external onlyRole(EMERGENCY_ROLE) {
        require(bytes(_reason).length > 0, "REASON_REQUIRED");
        require(_newNonce > currentNonce, "NONCE_MUST_INCREASE");

        uint256 oldNonce = currentNonce;
        currentNonce = _newNonce;

        emit NonceForceUpdated(oldNonce, _newNonce, _reason);
    }

    /// @notice Mark an attestation ID as used without executing it
    /// @dev Used to skip stuck/invalid attestations
    function invalidateAttestationId(
        bytes32 _attestationId,
        string calldata _reason
    ) external onlyRole(EMERGENCY_ROLE) {
        require(bytes(_reason).length > 0, "REASON_REQUIRED");
        require(!usedAttestationIds[_attestationId], "ALREADY_USED");

        usedAttestationIds[_attestationId] = true;

        emit AttestationInvalidated(_attestationId, _reason);
    }

    // ============================================================
    //                  CORE ATTESTATION LOGIC
    // ============================================================

    function executeAttestation(
        Attestation calldata att,
        bytes[] calldata signatures
    ) external nonReentrant whenNotPaused {
        require(signatures.length >= minSignatures, "INS_SIGS");
        require(att.nonce == currentNonce + 1, "INV_NONCE");
        require(att.target != address(0), "INVALID_TARGET");
        require(att.amount > 0, "INVALID_AMOUNT");

        // Verify attestation ID hasn't been used
        require(!usedAttestationIds[att.id], "ATTESTATION_ID_REUSED");

        if (att.isMint) {
            require(att.globalCantonAssets >= (att.amount * 110) / 100, "GLOBAL_CR_LOW");

            // NAV Oracle check (if enabled)
            if (navOracleEnabled) {
                _verifyNavOracle(att.globalCantonAssets);
            }

            _handleRateLimitMint(att.amount);
        } else {
            _handleRateLimitBurn(att.amount);
        }

        // Include address(this) in hash to prevent cross-chain replay
        bytes32 messageHash = keccak256(abi.encodePacked(
            att.id,
            att.globalCantonAssets,
            att.target,
            att.amount,
            att.isMint,
            att.nonce,
            block.chainid,
            address(this)
        ));

        bytes32 ethHash = messageHash.toEthSignedMessageHash();

        // Verify signatures are from validators and sorted (prevents duplicates)
        address lastSigner = address(0);
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ethHash.recover(signatures[i]);
            require(hasRole(VALIDATOR_ROLE, signer), "INV_VAL");
            require(signer > lastSigner, "SORT_ERR");
            lastSigner = signer;
        }

        // FIX C-2: Follow CEI pattern — all state changes before external calls
        // Effects: update all state before interacting with external musdToken
        usedAttestationIds[att.id] = true;
        totalCantonAssets = att.globalCantonAssets;
        currentNonce++;

        // Interactions: external calls after all state is committed
        if (att.isMint) {
            musdToken.mint(att.target, att.amount);
        } else {
            musdToken.burn(att.target, att.amount);
        }

        emit AttestationExecuted(att.id, att.target, att.amount, att.isMint, att.nonce);
    }

    // ============================================================
    //                    NAV ORACLE VERIFICATION
    // ============================================================

    /// @notice Verify the reported globalCantonAssets against the NAV oracle
    /// @dev Reverts if deviation exceeds maxNavDeviationBps
    function _verifyNavOracle(uint256 reportedAssets) internal view {
        (
            ,
            int256 answer,
            ,
            uint256 updatedAt,
        ) = navOracle.latestRoundData();

        // Ensure oracle data is fresh (within 1 hour)
        require(block.timestamp - updatedAt <= 1 hours, "STALE_NAV_DATA");
        require(answer > 0, "INVALID_NAV_VALUE");

        uint256 oracleValue = uint256(answer);
        uint8 oracleDecimals = navOracle.decimals();
        require(oracleDecimals <= 18, "UNSUPPORTED_ORACLE_DECIMALS");

        // Normalize to 18 decimals
        uint256 normalizedOracleValue = oracleValue * (10 ** (18 - oracleDecimals));

        // Calculate deviation
        uint256 deviation;
        if (reportedAssets > normalizedOracleValue) {
            deviation = ((reportedAssets - normalizedOracleValue) * 10000) / normalizedOracleValue;
        } else {
            deviation = ((normalizedOracleValue - reportedAssets) * 10000) / normalizedOracleValue;
        }

        require(deviation <= maxNavDeviationBps, "NAV_DEVIATION_TOO_HIGH");
    }

    // ============================================================
    //                      RATE LIMITING
    // ============================================================

    function _handleRateLimitMint(uint256 amount) internal {
        _resetDailyLimitsIfNeeded();

        // Net minting = dailyMinted - dailyBurned
        uint256 netMinted = dailyMinted > dailyBurned ? dailyMinted - dailyBurned : 0;
        require(netMinted + amount <= dailyMintLimit, "RATE_LIMIT");

        dailyMinted += amount;
    }

    function _handleRateLimitBurn(uint256 amount) internal {
        _resetDailyLimitsIfNeeded();
        dailyBurned += amount;
    }

    // FIX M-03: Use >= to prevent boundary timing attack at exact reset second
    function _resetDailyLimitsIfNeeded() internal {
        if (block.timestamp >= lastReset + 1 days) {
            dailyMinted = 0;
            dailyBurned = 0;
            lastReset = block.timestamp;
            emit RateLimitReset(block.timestamp);
        }
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function getNetDailyMinted() external view returns (uint256) {
        if (block.timestamp > lastReset + 1 days) {
            return 0;
        }
        return dailyMinted > dailyBurned ? dailyMinted - dailyBurned : 0;
    }

    function getRemainingDailyLimit() external view returns (uint256) {
        if (block.timestamp > lastReset + 1 days) {
            return dailyMintLimit;
        }
        uint256 netMinted = dailyMinted > dailyBurned ? dailyMinted - dailyBurned : 0;
        return netMinted >= dailyMintLimit ? 0 : dailyMintLimit - netMinted;
    }

    /// @notice Check if NAV oracle would accept the given asset value
    function checkNavDeviation(uint256 reportedAssets) external view returns (bool withinBounds, uint256 deviationBps) {
        if (!navOracleEnabled) {
            return (true, 0);
        }

        (
            ,
            int256 answer,
            ,
            uint256 updatedAt,
        ) = navOracle.latestRoundData();

        if (block.timestamp - updatedAt > 1 hours || answer <= 0) {
            return (false, type(uint256).max);
        }

        uint256 oracleValue = uint256(answer);
        uint8 oracleDecimals = navOracle.decimals();
        if (oracleDecimals > 18) {
            return (false, type(uint256).max);
        }
        uint256 normalizedOracleValue = oracleValue * (10 ** (18 - oracleDecimals));

        if (reportedAssets > normalizedOracleValue) {
            deviationBps = ((reportedAssets - normalizedOracleValue) * 10000) / normalizedOracleValue;
        } else {
            deviationBps = ((normalizedOracleValue - reportedAssets) * 10000) / normalizedOracleValue;
        }

        withinBounds = deviationBps <= maxNavDeviationBps;
    }

    // ============================================================
    //                      UPGRADEABILITY
    // ============================================================

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // Storage gap for future upgrades - MUST be at the end
    // 12 state variables declared above → 50 - 12 = 38
    uint256[38] private __gap;
}
