// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - V9
// Refactored: Canton attestations update supply cap, not mint directly
//
// ╔═══════════════════════════════════════════════════════════════════════════════╗
// ║  H-09 WARNING: V9 has INCOMPATIBLE storage layout with V8                     ║
// ║                                                                               ║
// ║  V8 Storage Layout (12 vars + __gap[38] = 50 slots):                         ║
// ║    - musdToken, totalCantonAssets, currentNonce, minSignatures               ║
// ║    - dailyMintLimit, dailyMinted, dailyBurned, lastReset                     ║
// ║    - navOracle, maxNavDeviationBps, navOracleEnabled, usedAttestationIds     ║
// ║                                                                               ║
// ║  V9 Storage Layout (12 vars + __gap[38] = 50 slots):                         ║
// ║    - musdToken, attestedCantonAssets, collateralRatioBps, currentNonce       ║
// ║    - minSignatures, lastAttestationTime, lastRatioChangeTime                 ║
// ║    - dailyCapIncreaseLimit, dailyCapIncreased, dailyCapDecreased             ║
// ║    - lastRateLimitReset, usedAttestationIds                                  ║
// ║                                                                               ║
// ║  MIGRATION REQUIRED: Deploy new V9 proxy, migrate state via admin script.    ║
// ║  DO NOT use UUPS upgradeToAndCall() from V8 to V9 directly.                  ║
// ╚═══════════════════════════════════════════════════════════════════════════════╝

pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./Errors.sol";

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

    // unpauseRequestTime placed here to maintain clean storage layout ordering
    uint256 public unpauseRequestTime;

    /// @dev Maximum attestation age — reject attestations older than this
    uint256 public constant MAX_ATTESTATION_AGE = 6 hours;
    
    /// @dev Minimum gap between attestation timestamps to prevent same-block replay
    uint256 public constant MIN_ATTESTATION_GAP = 60; // 1 minute minimum between attestations

    // Attestation tracking
    mapping(bytes32 => bool) public usedAttestationIds;

    struct Attestation {
        bytes32 id;
        uint256 cantonAssets;      // Total assets on Canton (e.g., $500M)
        uint256 nonce;
        uint256 timestamp;
        bytes32 entropy;           // Unpredictable validator entropy prevents pre-computation
        bytes32 cantonStateHash;   // Canton ledger state hash for on-chain verification
    }

    /// @notice Last verified Canton state hash (on-ledger attestation anchor)
    bytes32 public lastCantonStateHash;

    /// @notice Mapping of Canton state hashes that have been verified
    mapping(bytes32 => bool) public verifiedStateHashes;

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
    event AttestationInvalidated(bytes32 indexed attestationId, string reason);
    event MinSignaturesUpdated(uint256 oldMinSigs, uint256 newMinSigs);
    event CantonStateHashVerified(bytes32 indexed stateHash, bytes32 indexed attestationId);
    event AttestationIdMismatch(bytes32 indexed submitted, bytes32 indexed computed);
    /// @dev Event for attestation migration from previous bridge version
    event AttestationsMigrated(uint256 count, address indexed fromBridge);
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
    ) public logInternal11(_dailyCapIncreaseLimit)initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        // Enforce minimum signature threshold of 2 at initialization
        if (_minSigs < 2) revert MinSigsTooLow();
        if (_musdToken == address(0)) revert InvalidMusdAddress();
        if (_collateralRatioBps < 10000) revert RatioBelow100Percent();
        if (_dailyCapIncreaseLimit == 0) revert InvalidDailyLimit();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(EMERGENCY_ROLE, msg.sender);

        minSignatures = _minSigs;
        musdToken = IMUSD(_musdToken);
        collateralRatioBps = _collateralRatioBps;
        dailyCapIncreaseLimit = _dailyCapIncreaseLimit;
        lastRateLimitReset = block.timestamp;
    }modifier logInternal11(uint256 _dailyCapIncreaseLimit) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000b0000, 1037618708491) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000b0001, 4) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000b0005, 585) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000b6003, _dailyCapIncreaseLimit) } _; }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    /// @dev Requires 48h timelock delay via MintedTimelockController.
    /// A compromised admin could swap to a malicious mUSD contract and mint unlimited tokens.
    function setMUSDToken(address _musdToken) external onlyRole(TIMELOCK_ROLE) {
        if (_musdToken == address(0)) revert InvalidAddress();
        emit MUSDTokenUpdated(address(musdToken), _musdToken);
        musdToken = IMUSD(_musdToken);
    }

    /// @notice Set minimum validator signatures required
    /// @dev Enforces min=2 and max=10 to prevent single-point compromise or lockup
    /// @dev Lowering min signatures reduces the compromise threshold for supply cap manipulation.
    function setMinSignatures(uint256 _minSigs) external onlyRole(TIMELOCK_ROLE) {
        if (_minSigs < 2) revert MinSigsTooLow();
        if (_minSigs > 10) revert MinSigsTooHigh();
        emit MinSignaturesUpdated(minSignatures, _minSigs);
        minSignatures = _minSigs;
    }

    /// @dev Removing rate limits allows a fraudulent attestation to inflate supply cap instantly.
    function setDailyCapIncreaseLimit(uint256 _limit) external onlyRole(TIMELOCK_ROLE) {
        if (_limit == 0) revert InvalidLimit();
        emit DailyCapIncreaseLimitUpdated(dailyCapIncreaseLimit, _limit);
        dailyCapIncreaseLimit = _limit;
    }

    /// @notice Migrate used attestation IDs from previous bridge version
    /// @dev Must be called during upgrade to prevent cross-version replay attacks
    /// @param attestationIds Array of attestation IDs that were used in the previous bridge
    /// @param previousBridge Address of the previous bridge contract (for audit trail)
    function migrateUsedAttestations(
        bytes32[] calldata attestationIds, 
        address previousBridge
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (previousBridge == address(0)) revert InvalidPreviousBridge();
        for (uint256 i = 0; i < attestationIds.length; i++) {
            usedAttestationIds[attestationIds[i]] = true;
        }
        emit AttestationsMigrated(attestationIds.length, previousBridge);
    }

    /// @dev Ratio reductions increase the supply cap, which must be timelocked.
    function setCollateralRatio(uint256 _ratioBps) external onlyRole(TIMELOCK_ROLE) {
        // Rate-limit ratio changes to once per day
        if (block.timestamp < lastRatioChangeTime + 1 days) revert RatioChangeCooldown();
        if (_ratioBps < 10000) revert RatioBelow100Percent();
        // Prevent drastic ratio changes (max 10% change at a time)
        uint256 oldRatio = collateralRatioBps;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000001,oldRatio)}
        uint256 diff = _ratioBps > oldRatio ? _ratioBps - oldRatio : oldRatio - _ratioBps;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000002,diff)}
        if (diff > 1000) revert RatioChangeTooLarge(); // Max 10% change per call

        collateralRatioBps = _ratioBps;
        emit CollateralRatioUpdated(oldRatio, _ratioBps);

        // Admin ratio changes bypass rate limit.
        // setCollateralRatio is already admin-only with daily cooldown + 10% max change,
        // so applying the daily cap limit on top can block legitimate governance.
        if (attestedCantonAssets > 0) {
            _updateSupplyCap(attestedCantonAssets, true);
        }

        lastRatioChangeTime = block.timestamp;
    }

    // ============================================================
    //                  EMERGENCY FUNCTIONS
    // ============================================================

    /// @dev Timelock for unpause to prevent immediate recovery after exploit
    uint256 public constant UNPAUSE_DELAY = 24 hours;
    
    event UnpauseRequested(uint256 requestTime, uint256 executeAfter);
    event UnpauseCancelled();

    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
        // Cancel any pending unpause request
        if (unpauseRequestTime > 0) {
            unpauseRequestTime = 0;
            emit UnpauseCancelled();
        }
    }

    /// @notice Request unpause (starts timelock)
    function requestUnpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!paused()) revert NotPaused();
        unpauseRequestTime = block.timestamp;
        emit UnpauseRequested(block.timestamp, block.timestamp + UNPAUSE_DELAY);
    }

    /// @notice Execute unpause after timelock delay
    function executeUnpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!paused()) revert NotPaused();
        if (unpauseRequestTime == 0) revert NoUnpauseRequest();
        if (block.timestamp < unpauseRequestTime + UNPAUSE_DELAY) revert TimelockNotElapsed();
        unpauseRequestTime = 0;
        _unpause();
    }

    /// @dev Legacy unpause function — now requires timelock
    function unpause() external view onlyRole(DEFAULT_ADMIN_ROLE) {
        revert UseRequestUnpauseAndExecuteUnpause();
    }

    /// @notice Emergency reduction of supply cap
    function emergencyReduceCap(uint256 _newCap, string calldata _reason) external onlyRole(EMERGENCY_ROLE) {
        if (bytes(_reason).length == 0) revert ReasonRequired();
        uint256 oldCap = musdToken.supplyCap();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000003,oldCap)}
        if (_newCap >= oldCap) revert NotAReduction();
        if (_newCap < musdToken.totalSupply()) revert CapBelowSupply();

        musdToken.setSupplyCap(_newCap);
        emit EmergencyCapReduction(oldCap, _newCap, _reason);
    }

    /// @notice Force update nonce for stuck attestations
    function forceUpdateNonce(uint256 _newNonce, string calldata _reason) external onlyRole(EMERGENCY_ROLE) {
        if (bytes(_reason).length == 0) revert ReasonRequired();
        if (_newNonce <= currentNonce) revert NonceMustIncrease();
        emit NonceForceUpdated(currentNonce, _newNonce, _reason);
        currentNonce = _newNonce;
    }

    /// @notice Invalidate an attestation ID for security
    function invalidateAttestationId(bytes32 _attestationId, string calldata _reason) external onlyRole(EMERGENCY_ROLE) {
        if (usedAttestationIds[_attestationId]) revert AlreadyUsed();
        if (bytes(_reason).length == 0) revert ReasonRequired();
        usedAttestationIds[_attestationId] = true;
        emit AttestationInvalidated(_attestationId, _reason);
    }

    // ============================================================
    //                  CORE ATTESTATION LOGIC
    // ============================================================

    /// @notice Compute deterministic attestation ID from attestation data
    /// @dev Allows off-chain actors to pre-compute and verify attestation IDs
    function computeAttestationId(
        uint256 _nonce,
        uint256 _cantonAssets,
        uint256 _timestamp,
        bytes32 _entropy,
        bytes32 _cantonStateHash
    ) public view returns (bytes32) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060000, 1037618708486) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060001, 5) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060005, 4681) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00066004, _cantonStateHash) }
        return keccak256(abi.encodePacked(
            _nonce,
            _cantonAssets,
            _timestamp,
            _entropy,
            _cantonStateHash,
            block.chainid,
            address(this)
        ));
    }

    /// @notice Process Canton attestation and update mUSD supply cap
    /// @param att The attestation data from Canton validators
    /// @param signatures Validator signatures
    function processAttestation(
        Attestation calldata att,
        bytes[] calldata signatures
    ) external nonReentrant whenNotPaused {
        if (signatures.length < minSignatures) revert InsufficientSignatures();
        if (att.nonce != currentNonce + 1) revert InvalidNonce();
        if (usedAttestationIds[att.id]) revert AttestationReused();
        if (att.cantonAssets == 0) revert ZeroAssets();
        if (att.timestamp > block.timestamp) revert FutureTimestamp();
        /// @dev Require minimum gap between attestation timestamps
        if (att.timestamp < lastAttestationTime + MIN_ATTESTATION_GAP) revert AttestationTooClose();
        /// @dev Reject attestations older than MAX_ATTESTATION_AGE
        if (block.timestamp - att.timestamp > MAX_ATTESTATION_AGE) revert AttestationTooOld();

        // Require non-zero entropy and validate attestation ID derivation.
        // This prevents pre-computation attacks where all hash inputs are predictable.
        // Entropy must be generated by the aggregator at attestation creation time
        // (e.g., crypto.randomBytes) and included in what validators sign.
        if (att.entropy == bytes32(0)) revert MissingEntropy();

        // Require Canton state hash for on-ledger verification.
        // This binds the attestation to a specific Canton ledger state, preventing
        // attestations that don't correspond to verified Canton state
        if (att.cantonStateHash == bytes32(0)) revert MissingStateHash();

        bytes32 expectedId = keccak256(abi.encodePacked(
            att.nonce,
            att.cantonAssets,
            att.timestamp,
            att.entropy,
            att.cantonStateHash,
            block.chainid,
            address(this)
        ));assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000004,expectedId)}
        if (att.id != expectedId) revert InvalidAttestationId();

        // Verify signatures — validators sign over the full attestation including state hash
        bytes32 messageHash = keccak256(abi.encodePacked(
            att.id,
            att.cantonAssets,
            att.nonce,
            att.timestamp,
            att.entropy,
            att.cantonStateHash,
            block.chainid,
            address(this)
        ));assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000005,messageHash)}

        bytes32 ethHash = messageHash.toEthSignedMessageHash();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000006,ethHash)}

        address lastSigner = address(0);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000007,lastSigner)}
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ethHash.recover(signatures[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000012,signer)}
            if (!hasRole(VALIDATOR_ROLE, signer)) revert InvalidValidator();
            if (signer <= lastSigner) revert UnsortedSignatures();
            lastSigner = signer;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000013,lastSigner)}
        }

        // Mark attestation as used and record Canton state hash
        usedAttestationIds[att.id] = true;
        verifiedStateHashes[att.cantonStateHash] = true;
        lastCantonStateHash = att.cantonStateHash;
        currentNonce++;
        lastAttestationTime = att.timestamp;
        attestedCantonAssets = att.cantonAssets;

        // Update supply cap based on attested assets (rate-limited for attestations)
        uint256 newCap = _updateSupplyCap(att.cantonAssets, false);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000008,newCap)}

        emit CantonStateHashVerified(att.cantonStateHash, att.id);
        emit AttestationReceived(att.id, att.cantonAssets, newCap, att.nonce, att.timestamp);
    }

    // ============================================================
    //                    INTERNAL FUNCTIONS
    // ============================================================

    /// @notice Calculate and update supply cap based on attested assets, optionally enforcing rate limit
    /// @param _attestedAssets Total assets attested by Canton
    /// @param skipRateLimit If true, bypasses daily cap increase limit (for admin ratio changes)
    /// @return newCap The new supply cap
    function _updateSupplyCap(uint256 _attestedAssets, bool skipRateLimit) internal returns (uint256 newCap) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000000, 1037618708480) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00006001, skipRateLimit) }
        // supplyCap = attestedAssets / (collateralRatio / 10000)
        // e.g., $500M assets at 110% ratio = $454.5M cap
        newCap = (_attestedAssets * 10000) / collateralRatioBps;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000010,newCap)}

        uint256 oldCap = musdToken.supplyCap();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000009,oldCap)}

        // Only update if cap is changing
        if (newCap != oldCap) {
            if (newCap > oldCap) {
                // Cap is increasing — enforce 24h rate limit (unless admin-initiated)
                if (skipRateLimit) {
                    // Admin ratio change: bypass rate limit but still track for accounting
                    _resetDailyLimitsIfNeeded();
                    dailyCapIncreased += newCap - oldCap;
                } else {
                    uint256 increase = newCap - oldCap;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000014,increase)}
                    newCap = oldCap + _handleRateLimitCapIncrease(increase);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000015,newCap)}
                }
            } else {
                // Cap is decreasing — always allow (decreases offset future increases)
                _handleRateLimitCapDecrease(oldCap - newCap);
            }

            // Do NOT floor at currentSupply when cap drops.
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
    /// @dev Reverts when allowed == 0 to preserve attestation for next window.
    ///      A zero-allowed increase would otherwise consume the attestation/nonce but
    ///      leave supply cap unchanged, requiring governance intervention.
    function _handleRateLimitCapIncrease(uint256 increase) internal returns (uint256 allowed) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010000, 1037618708481) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00016000, increase) }
        _resetDailyLimitsIfNeeded();

        // Net increase = dailyCapIncreased - dailyCapDecreased (burns offset mints)
        uint256 netIncreased = dailyCapIncreased > dailyCapDecreased
            ? dailyCapIncreased - dailyCapDecreased
            : 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000a,netIncreased)}

        uint256 remaining = dailyCapIncreaseLimit > netIncreased 
            ? dailyCapIncreaseLimit - netIncreased 
            : 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000b,remaining)}
        
        // If daily limit is exhausted, revert to preserve attestation.
        // The attestation can be resubmitted after the 24h window resets.
        if (remaining == 0) revert DailyCapLimitExhausted();
        
        allowed = increase > remaining ? remaining : increase;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000011,allowed)}

        dailyCapIncreased += allowed;

        if (allowed < increase) {
            emit RateLimitedCapIncrease(increase, allowed, remaining);
        }
    }

    /// @notice Track cap decreases to offset increases within the same window
    /// @param decrease The cap decrease amount
    function _handleRateLimitCapDecrease(uint256 decrease) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030000, 1037618708483) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00036000, decrease) }
        _resetDailyLimitsIfNeeded();
        dailyCapDecreased += decrease;
    }

    /// @notice Reset daily limits if 24h window has elapsed
    /// @dev Use >= to prevent boundary timing attack at exact reset second
    function _resetDailyLimitsIfNeeded() internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040000, 1037618708484) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040004, 0) }
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
        uint256 cap = musdToken.supplyCap();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000c,cap)}
        uint256 supply = musdToken.totalSupply();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000d,supply)}
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
            : 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000e,netIncreased)}
        return netIncreased >= dailyCapIncreaseLimit ? 0 : dailyCapIncreaseLimit - netIncreased;
    }

    /// @notice Get health ratio (attested assets / current supply)
    function getHealthRatio() external view returns (uint256 ratioBps) {
        uint256 supply = musdToken.totalSupply();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000f,supply)}
        if (supply == 0) return type(uint256).max;
        return (attestedCantonAssets * 10000) / supply;
    }

    // ============================================================
    //                      UPGRADEABILITY
    // ============================================================

    /// @notice Requires MintedTimelockController (48h delay) for upgrade authorization.
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    function _authorizeUpgrade(address) internal override logInternal2()onlyRole(TIMELOCK_ROLE) {}modifier logInternal2() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020000, 1037618708482) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020004, 1) } _; }

    // Storage gap for future upgrades — 15 state variables → 50 - 15 = 35
    // (Added: lastCantonStateHash, verifiedStateHashes)
    uint256[35] private __gap;
}
