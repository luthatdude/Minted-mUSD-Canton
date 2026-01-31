# Audit Readiness Report -- Minted mUSD Canton Protocol

**Date:** 2026-01-31
**Scope:** All Solidity contracts, DAML templates, tests, deployment scripts, CI/CD, infrastructure
**Verdict: NOT AUDIT READY**

**Total Findings: 6 Critical | 18 High | 24 Medium | 19 Low | 12 Informational**

---

## Executive Summary

The Minted mUSD protocol is a cross-chain stablecoin system spanning Canton Network (DAML) and Ethereum (Solidity). While it shows significant engineering effort -- particularly in `MintedProtocolV2Fixed.daml` which has resolved 98 prior security findings -- critical issues remain across multiple layers that must be addressed before a formal audit engagement.

Key blockers:
- **LeverageVault is non-functional** -- users permanently lose collateral
- **Treasury accounting errors** that cause drift over time
- **~50% of deployed contracts have zero test coverage**
- **CI security gates are all no-ops** (`continue-on-error: true`)
- **DAML attestation quorum can be bypassed** in V3

---

## CRITICAL FINDINGS

### C-01: LeverageVault.closeLeveragedPosition Never Withdraws Collateral
**File:** `contracts/LeverageVault.sol:270-330`

The function reads `remainingCollateral` and claims to return it to the user, but never calls `CollateralVault.withdraw()` or equivalent. The collateral remains locked forever. The code comments acknowledge this:
```
// Note: This requires CollateralVault to support withdrawFor or user pre-approval
```
**Impact:** Complete loss of funds for any user who opens a leveraged position.

### C-02: LeverageVault Permanently Locks Out Users
**File:** `contracts/LeverageVault.sol:213`

```solidity
require(positions[msg.sender].totalCollateral == 0, "POSITION_EXISTS");
```
Combined with C-01 (positions can never be properly closed), users are permanently blocked from the leverage system after their first position.

### C-03: TreasuryV2 Double-Counts Yield on Strategy Slippage
**File:** `contracts/TreasuryV2.sol:572-586`

When strategy deposits experience slippage, the accounting mismatch is interpreted as yield/loss, triggering incorrect fee accrual.
**Impact:** Protocol fees slowly drain value from depositors.

### C-04: Treasury.recordStrategyReturn Accounting Breaks on Profitable Returns
**File:** `contracts/Treasury.sol:182-195`

When strategies return more than principal (i.e., yield), the excess is transferred but never tracked. `deployedToStrategies` becomes permanently skewed, causing `totalBacking()` to undercount.
**Impact:** Protocol believes it has less backing than reality, blocking legitimate operations.

### C-05: DepositRouter Uses Unsafe approve Instead of forceApprove
**File:** `contracts/DepositRouter.sol:320`

Some USDC implementations require allowance to be zero before setting a new value. A partially failed transaction leaves non-zero allowance, permanently DoS-ing the deposit function.

### C-06: MUSD_Protocol.Cancel_BridgeLock Bypasses Supply Tracking
**File:** `daml/MUSD_Protocol.daml:311-318`

Cancelling a bridge lock creates new mUSD without updating `MintingService.currentSupply`. Repeated lock/cancel cycles desynchronize the supply tracker.

---

## HIGH FINDINGS

### Solidity

| ID | Finding | File |
|----|---------|------|
| H-01 | `TreasuryV2.withdrawToVault` silently returns less than requested | `contracts/TreasuryV2.sol:340-372` |
| H-04 | Dangling token approvals to strategies after deposits | `contracts/TreasuryV2.sol:497-507` |
| H-05 | Same dangling approval in Treasury V1 | `contracts/Treasury.sol:270-280` |
| H-06 | `BLEBridgeV8.maxNavDeviationBps` allows 100% deviation | `contracts/BLEBridgeV8.sol:142` |
| H-07 | `TreasuryReceiver.receiveAndMint` never mints -- `directMint` is dead code | `contracts/TreasuryReceiver.sol:131-164` |
| H-09 | BLEBridgeV9 storage layout incompatible with V8 | `contracts/BLEBridgeV9.sol:5-12` |
| H-10 | `LeverageVault._getCollateralForMusd` hardcodes 18 decimals -- broken for WBTC | `contracts/LeverageVault.sol:481` |

### DAML

| ID | Finding | File |
|----|---------|------|
| A-01 | `MintedMUSD.MUSD` provider-only signatory -- unilateral control | `daml/MintedMUSD.daml:17-19` |
| A-03 | `V3.Attestation_Complete` quorum is caller-supplied, bypassable | `daml/Minted/Protocol/V3.daml:1008-1014` |
| A-02 | `MUSD_Protocol.StakingService` fragile authorization chain | `daml/MUSD_Protocol.daml:237-265` |
| C-02d | `MintedProtocol.LiquidityPool` drainable by any visible party | `daml/MintedProtocol.daml:111-127` |
| D-02 | `BLEBridgeProtocol._Sign` allows duplicate validator signatures | `daml/BLEBridgeProtocol.daml:88-110` |
| K-01 | `SecureAsset.Asset` key prevents multiple holdings | `daml/SecureAsset.daml:16-17` |
| W-02 | `MUSD_Protocol.Finalize_Bridge_Mint` unilateral supply modification | `daml/MUSD_Protocol.daml:407-422` |
| W-03 | Staking yield bypasses supply cap entirely | `daml/MUSD_Protocol.daml:256-285` |

### Testing & Infrastructure

| ID | Finding | Location |
|----|---------|----------|
| T-01 | BLEBridgeV9 (deployed bridge) has ZERO test coverage | `test/` |
| T-02 | DirectMintV2, DepositRouter, TreasuryReceiver: ZERO tests | `test/` |
| T-03 | All CI security checks use `continue-on-error: true` | `.github/workflows/ci.yml` |

---

## MEDIUM FINDINGS

### Solidity
- `LeverageVault` uses meaningless `block.timestamp + 300` swap deadline
- `TreasuryV2` missing events on `setFeeConfig`, `setReserveBps`, `setMinAutoAllocate`
- One broken strategy bricks entire TreasuryV2 (`totalValue()` reverts propagate)
- `TreasuryV2.removeStrategy` silently eats funds if `withdrawAll` fails
- `CollateralVault.supportedTokens` never shrinks (gas bloat up to 50 entries)
- `PendleMarketSelector.whitelistedMarkets` has no size limit
- `BorrowModule.setInterestRate` allows setting rate to zero
- `TreasuryV2.initialize` missing zero-address check for fee recipient
- `DirectMint` redemption truncation loses up to ~$0.000001 per tx
- `DepositRouter.withdrawFees` missing zero-amount check

### DAML
- Multiple modules use direct transfer without proposal pattern (V3.MintedMUSD, CooldownTicket, MintedProtocol.Asset)
- `Compliance.ValidateMint` requires both regulator AND operator, blocking single-party flows
- `BLEProtocol.ValidatorSignature` has aggregator as sole signatory (forgery risk)
- V3 and MintedProtocol `PriceOracle` have no staleness checks
- V3/CantonSMUSD staking yield not tracked in supply cap
- V3 Vault allows zero-collateral zero-debt vaults
- `CantonDirectMint.DirectMint_WithdrawFees` resets counter without paying out
- `BLEBridgeProtocol` signature contracts not archived on finalization
- V3 `Vault.Liquidate` has no self-liquidation prevention
- `BLEBridgeProtocol.UpdateEquity` allows zero equity value

### Testing & Infrastructure
- No reentrancy, flash loan, or oracle manipulation attack tests
- Dependencies use `^` ranges instead of pinned versions
- `deploy-testnet.ts` has constructor mismatch (`MUSD.deploy()` with no args)
- `deploy-testnet.ts` never grants `BORROW_MODULE_ROLE`
- Bot hardcodes ETH price at $2500

---

## INFORMATIONAL / LOW FINDINGS

- Mock contracts (4) should never reach production
- Pragma inconsistency: `^0.8.20` vs `0.8.26`
- Dead code: `PendleMarketSelector._isValidMarket`, `PrivateTxSender` class, `node-telegram-bot-api` dep
- `TokenInterface.daml` is empty
- Frontend `.next/` build artifacts committed to git
- No `SECURITY.md`, deployment checklist, threat model, or architecture diagram
- All `Ownable` contracts use single-key ownership (should be multisig)
- `DEFAULT_ADMIN_ROLE` grants god-mode across protocol
- `node_modules/` not present -- tests cannot run without `npm ci`
- Flashbots auth signer reuses liquidation wallet key
- `_lnRateToAPY` approximation underestimates at >20% rates

---

## WHAT'S AUDIT-POSITIVE

- `MintedProtocolV2Fixed.daml` is mature -- 98 prior findings resolved, proper signatories, staleness checks, rate limiting, replay protection
- `CantonDirectMint.daml` has compliance hooks, dual-signatory proposals
- Consistent OpenZeppelin usage: `SafeERC20`, `ReentrancyGuard`, `AccessControl`
- Storage gaps on all upgradeable contracts
- Proper `.gitignore` excludes secrets and keys
- Docker security: `read_only`, `no-new-privileges`, resource limits
- K8s: `NetworkPolicy` (default-deny), Pod Security Standards, PDBs
- 60+ existing tests with fixture isolation, negative tests, boundary checks
- ERC-4626 compliance in SMUSD
- Flashbots MEV protection for liquidation bot

---

## TOP 10 ACTIONS TO REACH AUDIT READINESS

| # | Action | Why |
|---|--------|-----|
| 1 | Fix or remove `LeverageVault` | Non-functional: permanently locks user collateral |
| 2 | Add tests for BLEBridgeV9, DirectMintV2, DepositRouter, TreasuryReceiver | ~50% of deployed contracts untested |
| 3 | Fix Treasury accounting (C-03, C-04) | Yield/slippage tracking causes drift |
| 4 | Remove `continue-on-error: true` from CI security jobs | Security gates are currently meaningless |
| 5 | Fix `V3.Attestation_Complete` to derive quorum from validator group | Prevents attestation bypass |
| 6 | Revoke dangling approvals after strategy deposits | Reduces blast radius if strategy compromised |
| 7 | Fix `TreasuryReceiver.receiveAndMint` or remove dead code | Cross-chain users send USDC but get nothing |
| 8 | Add staleness checks to V3 and MintedProtocol PriceOracles | Prevents stale price exploitation |
| 9 | Pin dependency versions, add SECURITY.md and threat model | Auditor documentation requirements |
| 10 | Fix `DepositRouter` approve and `LeverageVault` decimal assumptions | Prevents DoS and incorrect math |

---

## TEST COVERAGE MATRIX

| Contract | Tests | Coverage |
|----------|-------|----------|
| DirectMint (V1) | 18 tests | Good |
| BorrowModule | 18 tests | Good (single-collateral only) |
| LeverageVault | 14 tests | Partial (no close/deleverage) |
| LiquidationEngine | 14 tests | Good |
| TreasuryV2 | 20 tests | Good |
| BLEBridgeV8 | 22 tests | Good |
| **BLEBridgeV9** | **0 tests** | **None** |
| **DirectMintV2** | **0 tests** | **None** |
| **DepositRouter** | **0 tests** | **None** |
| **TreasuryReceiver** | **0 tests** | **None** |
| **PendleMarketSelector** | **0 tests** | **None** |
| **MUSD** (standalone) | Indirect only | Partial |
| **SMUSD** (standalone) | Indirect only | Partial |
| **Treasury V1** | **0 tests** | **None** |
| DAML (MintedProtocolV2Fixed) | 11 tests | Good |
| DAML (CantonDirectMint) | 9 tests | Good |

**Estimated overall coverage: ~50-60%**

---

## CENTRALIZATION RISK SUMMARY

| Contract | Risk | Mitigation Needed |
|----------|------|-------------------|
| MUSD | `DEFAULT_ADMIN_ROLE` can grant any role | Multisig + timelock |
| DepositRouter | Single `Ownable` owner | Multisig |
| TreasuryReceiver | Single `Ownable` owner | Multisig |
| PendleMarketSelector | Single `Ownable` owner | Multisig |
| LeverageVault | `emergencyWithdraw` can extract any token | Restrict to non-user tokens |
| All contracts | `DEFAULT_ADMIN_ROLE` = god mode | Role separation + timelock |
