# Canton Network Deep Absorption — Research Findings

**Date:** 2026-02-22
**Sources:** Canton 3.3 Docs, `digital-asset/cn-quickstart`, `canton-network` org, `hyperledger-labs/splice`, current Minted mUSD codebase audit
**Purpose:** Inform the next generation of the Minted mUSD Protocol to align with Canton-native patterns, Splice token standards, and production DevNet architecture.

---

## Table of Contents

1. [Canton 3.3 Architecture](#1-canton-33-architecture)
2. [The cn-quickstart Reference App](#2-the-cn-quickstart-reference-app)
3. [Splice / Global Synchronizer / Amulet](#3-splice--global-synchronizer--amulet)
4. [Canton Token Standard (Splice API)](#4-canton-token-standard-splice-api)
5. [DAML Patterns — What Canton-Native Looks Like](#5-daml-patterns--what-canton-native-looks-like)
6. [Ledger API v2 / PQS / JSON API](#6-ledger-api-v2--pqs--json-api)
7. [Frontend Integration Patterns](#7-frontend-integration-patterns)
8. [Infrastructure & Deployment](#8-infrastructure--deployment)
9. [Gap Analysis — Minted mUSD vs Canton-Native](#9-gap-analysis--minted-musd-vs-canton-native)
10. [Recommendations — What Changes](#10-recommendations--what-changes)
11. [RWA Collateral Onboarding Path](#11-rwa-collateral-onboarding-path)

---

## 1. Canton 3.3 Architecture

### Core Topology

Canton is **not a blockchain** — it's a **privacy-enabled synchronization protocol** for distributed ledgers.

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Participant 1 │    │ Participant 2 │    │ Participant 3 │
│  (AppProvider)│    │   (AppUser)   │    │     (SV)      │
│    DAML ↕     │    │    DAML ↕     │    │   Splice ↕    │
│  Ledger API   │    │  Ledger API   │    │  Ledger API   │
└──────┬────────┘    └──────┬────────┘    └──────┬────────┘
       │                    │                    │
       └────────────┬───────┴────────────────────┘
                    │
          ┌─────────┴─────────┐
          │   Synchronizer     │
          │  ┌──────────────┐  │
          │  │  Sequencer   │  │  ← Totally ordered message bus
          │  ├──────────────┤  │
          │  │  Mediator    │  │  ← Confirms transaction validity
          │  └──────────────┘  │
          └────────────────────┘
```

**Key Properties:**
- **Privacy by default**: Only transaction participants see the data. No global state broadcast.
- **Sub-transaction privacy**: Different parts of a single transaction can be visible to different parties.
- **Synchronizers are pluggable**: Multiple synchronizers can coexist; participants can be connected to several simultaneously.
- **No global consensus**: Only parties involved in a transaction participate in its validation.
- **GDPR-compliant**: Data can be pruned/forgotten per regulatory requirements.

### Participant Nodes

Each participant:
- Runs the DAML engine locally
- Has a local Postgres database (or similar) for its ledger state
- Exposes the **Ledger API v2** (gRPC) for application integration
- Can optionally run **PQS** (Participant Query Store) for SQL-based contract queries

### The Global Synchronizer

Operated by **Super Validators (SVs)** through the **Splice** system:
- Provides the shared sequencing and mediation layer
- SVs run: sequencer node + mediator node + SV app
- Canton Coin (Amulet/CC) is the native utility token for transaction fees
- Decentralized governance through SV voting

### Network Modes

| Mode | Use Case | Topology |
|------|----------|----------|
| **DevNet** | Development & testing | Splice LocalNet (single-machine Docker) |
| **TestNet** | Pre-production validation | Shared test synchronizer |
| **MainNet** | Production | Global Synchronizer with real SVs |

---

## 2. The cn-quickstart Reference App

### Project Structure

```
quickstart/
├── daml/                          # DAML model (on-ledger logic)
│   ├── daml.yaml                  # SDK config
│   └── licensing/                 # Module: quickstart_licensing
│       ├── Licensing/
│       │   ├── AppInstall.daml    # App install request/accept
│       │   ├── License.daml       # License template with expiry + renewal
│       │   └── Splice.daml        # Splice token standard integration
│       └── Scripts/
│           └── Onboard.daml       # Onboarding automation scripts
├── backend/                       # Spring Boot Java backend
│   └── src/main/java/com/digitalasset/quickstart/
│       ├── api/                   # OpenAPI-generated interfaces
│       ├── config/                # LedgerConfig, AuthConfig
│       ├── ledger/                # LedgerApi (gRPC), TokenStandardProxy
│       ├── repository/            # DamlRepository (PQS queries)
│       ├── security/              # AuthUtils, OAuth2/shared-secret
│       └── service/               # LicenseApiImpl, AppInstallApiImpl
├── frontend/                      # Vite + TypeScript UI
├── common/                        # OpenAPI spec (openapi.yaml)
├── docker/                        # Docker service configs
├── integration-test/              # Playwright E2E tests
├── compose.yaml                   # Docker Compose orchestration
├── Makefile                       # Build/run/test commands
└── build.gradle.kts               # Gradle build system
```

### The DAML Model — License App

The cn-quickstart implements a **Software Licensing** app as its demo. This is the canonical reference for how to build on Canton.

#### AppInstall Template (Propose-Accept Pattern)

```daml
-- AppInstallRequest: User requests to install app from provider
template AppInstallRequest
  with
    provider : Party
    user : Party
    meta : Metadata
  where
    signatory user
    observer provider

    choice AppInstallRequest_Accept : ContractId AppInstall
      with
        installMeta : Metadata
      controller provider
      do create AppInstall with ..

    choice AppInstallRequest_Reject : ()
      controller provider
      do pure ()
```

#### License Template (with Splice Token Integration)

```daml
template License
  with
    provider : Party
    user : Party
    licenseNum : Int
    params : LicenseParams
    expiresAt : Time
  where
    signatory provider, user

    -- Renew uses Splice Token Standard for payment
    choice License_Renew : ContractId LicenseRenewalRequest
      with
        requestId : Text
        instrumentId : InstrumentId      -- Splice token instrument
        licenseFeeAmount : Decimal        -- Fee in Canton Coin
        extensionDuration : RelTime
        prepareUntil : Time
        settleBefore : Time
        description : Text
      controller provider
      do create LicenseRenewalRequest with ..

    choice License_Expire : ()
      with
        actor : Party
        meta : Metadata
      controller actor
      do pure ()
```

#### Splice Integration (Token Standard)

```daml
-- In Licensing/Splice.daml
-- Implements the Splice Token Standard interfaces for payment

import Splice.Api.Token.MetadataV1
import Splice.Api.Token.HoldingV1

-- The app registers with Splice's token registry
-- Payments flow through Splice's allocation/transfer mechanism
-- Canton Coin (Amulet) is used as the payment instrument
```

### Key Architectural Patterns from cn-quickstart

1. **Gradle Build System** (not `daml build` directly)
   - `./gradlew :daml:build` — builds DAML
   - `./gradlew :backend:build` — builds Java backend
   - `./gradlew :daml:testDaml` — runs DAML tests
   - Frontend: `npm install && npm run build`

2. **Backend: Spring Boot + gRPC + PQS**
   - `LedgerApi.java` wraps the Ledger API v2 gRPC client
   - `DamlRepository.java` queries contracts via PQS (Postgres)
   - `TokenStandardProxy.java` integrates with Splice token standard API
   - Auth: OAuth2 (Keycloak) or shared-secret modes

3. **Multi-Tenant Architecture**
   - AppProvider is the primary tenant (internal)
   - AppUsers register as external tenants
   - Each tenant has their own participant node and party
   - Backend maps authenticated users to parties

4. **Splice Onboarding**
   - Participant nodes connect to the Splice network
   - DARs are uploaded via onboarding service
   - AppInstallRequest triggers the propose-accept flow

5. **Docker Compose Modules**
   - `localnet/` — Splice LocalNet (SV node, sequencer, mediator)
   - `keycloak/` — OAuth2 identity provider
   - `pqs/` — Participant Query Store (Postgres-based)
   - `splice-onboarding/` — DAR upload and app registration
   - `backend-service/` — The Spring Boot app
   - `observability/` — Grafana, Prometheus, OpenTelemetry

---

## 3. Splice / Global Synchronizer / Amulet

### Where the Code Lives

| Repository | Purpose |
|-----------|---------|
| `hyperledger-labs/splice` | Active development of Splice (SV nodes, Amulet, Global Synchronizer) |
| `digital-asset/decentralized-canton-sync` | Release distribution hub (58 releases, latest v0.5.12) |
| `digital-asset/cn-quickstart` | Reference app for building on the network |
| `digital-asset/canton` | Canton protocol itself (Scala, v3.4.11) |
| `canton-network` org | Almost entirely private repos |

### Splice Architecture

Splice is the **decentralized governance and tokenization layer** running on Canton:

```
┌───────────────────────────────────────────────────┐
│                  Global Synchronizer                │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐      │
│  │   SV-1    │  │   SV-2    │  │   SV-3    │ ...  │
│  │ Sequencer │  │ Sequencer │  │ Sequencer │      │
│  │ Mediator  │  │ Mediator  │  │ Mediator  │      │
│  │ SV App    │  │ SV App    │  │ SV App    │      │
│  └───────────┘  └───────────┘  └───────────┘      │
│                                                     │
│  Amulet (Canton Coin / CC)                         │
│  ├── Native utility token for transaction fees     │
│  ├── Minted through "tapping" (DevNet)             │
│  ├── Used for app payments via Token Standard      │
│  └── Wallet app for CC management                  │
│                                                     │
│  Token Standard APIs                                │
│  ├── Metadata API — registry info, admin ID        │
│  ├── Allocation API — prepare/settle transfers     │
│  └── Holding API — instrument tracking             │
└───────────────────────────────────────────────────┘
```

### Canton Coin (Amulet / CC)

- **Not a stablecoin** — it's a utility/governance token
- Used to pay transaction fees on the Global Synchronizer
- SVs earn CC through validation rewards
- Apps can charge fees in CC via the Token Standard
- DevNet: Users can "tap" (faucet) CC for testing
- **This is NOT competing with mUSD** — CC is infrastructure, mUSD is a product

### Token Standard Integration

The cn-quickstart shows the pattern for integrating with Splice's token standard:

```java
// TokenStandardProxy.java
public class TokenStandardProxy {
    private final DefaultAllocationApi allocationApi;   // Allocation/transfer context
    private final DefaultMetadataApi metadataApi;       // Registry info

    // Get registry admin for token operations
    public CompletableFuture<String> getRegistryAdminId() { ... }

    // Get allocation context for completing transfers
    public CompletableFuture<Optional<ChoiceContext>> getAllocationTransferContext(
        String allocationId) { ... }
}
```

**Payment Flow:**
1. Provider creates `LicenseRenewalRequest` specifying fee in CC
2. User's wallet receives the request as an "allocation request"
3. User accepts allocation in wallet (prepares payment)
4. Provider calls `CompleteRenewal` with the allocation contract ID
5. Splice settles the CC transfer atomically with the license renewal

---

## 4. Canton Token Standard (Splice API)

### The Standard Interfaces

Splice defines a set of standard APIs that apps integrate with:

```
splice_api_token_holding_v1    — InstrumentId, holdings, balances
splice_api_token_metadata_v1   — Metadata, ChoiceContext, ExtraArgs, AnyValue
splice_api_token_allocation_v1 — Allocation, transfer context
```

### InstrumentId

```java
import splice_api_token_holding_v1.splice.api.token.holdingv1.InstrumentId;

// An instrument is identified by (admin party, instrument name)
new InstrumentId(new Party(adminId), "Amulet")
```

### Metadata Pattern

```java
import splice_api_token_metadata_v1.splice.api.token.metadatav1.Metadata;
import splice_api_token_metadata_v1.splice.api.token.metadatav1.ChoiceContext;
import splice_api_token_metadata_v1.splice.api.token.metadatav1.ExtraArgs;

// Choices that involve token transfers take ExtraArgs
// containing ChoiceContext (disclosed contracts) + Metadata
new ExtraArgs(
    new ChoiceContext(Map.of(
        "amulet-rules", amuletRulesContractId,
        "open-round", openRoundContractId
    )),
    new Metadata(Map.of())  // key-value metadata
);
```

### Disclosed Contracts

For cross-participant token operations, Canton requires "disclosed contracts":

```java
// Contracts from other participants that are needed for the transaction
// Must be provided as CreatedEventBlobs
CommandsOuterClass.DisclosedContract.newBuilder()
    .setTemplateId(templateId)
    .setContractId(contractId)
    .setCreatedEventBlob(ByteString.copyFrom(blob))
    .build();
```

**This is critical** — when bridging between Canton parties, the contracts needed for the operation must be disclosed. This is different from Ethereum where everything is public.

---

## 5. DAML Patterns — What Canton-Native Looks Like

### Pattern 1: Propose-Accept (Universal on Canton)

Every multi-party interaction follows this:

```daml
-- Step 1: Initiator creates a proposal (single signatory)
template Proposal
  with
    initiator : Party
    counterparty : Party
  where
    signatory initiator
    observer counterparty

    choice Accept : ContractId Agreement
      controller counterparty
      do create Agreement with ..

    choice Reject : ()
      controller counterparty
      do pure ()

    choice Cancel : ()
      controller initiator
      do pure ()

-- Step 2: Counterparty accepts → creates multi-signatory contract
template Agreement
  with
    party1 : Party
    party2 : Party
  where
    signatory party1, party2
```

### Pattern 2: Interface-Based Templates (DAML 2.x)

Modern Canton apps use **DAML interfaces** for pluggable behavior:

```daml
-- Define an interface that multiple templates can implement
interface IAsset where
  viewtype AssetView
  getOwner : Party
  getAmount : Decimal
  transfer : Party -> Update (ContractId IAsset)

data AssetView = AssetView
  { owner : Party
  , amount : Decimal
  }

-- Any token template can implement this interface
template CantonCoin
  with
    owner : Party
    amount : Decimal
  where
    signatory owner
    interface instance IAsset for CantonCoin where
      view = AssetView owner amount
      getOwner = owner
      getAmount = amount
      transfer newOwner = do
        cid <- create this with owner = newOwner
        pure (toInterfaceContractId cid)
```

**This is the pattern Minted mUSD should adopt for pluggable collateral.**

### Pattern 3: Contract Keys (with LF 2.x Caveats)

```daml
template Service
  with
    operator : Party
    serviceName : Text
  where
    signatory operator
    key (operator, serviceName) : (Party, Text)
    maintainer key._1
```

**IMPORTANT**: LF 2.x removed contract key uniqueness guarantees. `fetchByKey` still works but `lookupByKey` can return stale results. Modern pattern: pass `ContractId` explicitly rather than relying on key lookups.

### Pattern 4: Nonconsuming Choices for Queries

```daml
template PriceOracle
  with
    provider : Party
    price : Decimal
    updatedAt : Time
  where
    signatory provider

    -- Read-only: doesn't archive the contract
    nonconsuming choice GetPrice : Decimal
      controller provider
      do pure price

    -- Mutating: archives and recreates
    choice UpdatePrice : ContractId PriceOracle
      with newPrice : Decimal
      controller provider
      do create this with price = newPrice; updatedAt = now
```

### Pattern 5: Daml Script for Testing

```daml
module Test where
import Daml.Script

testLicenseWorkflow : Script ()
testLicenseWorkflow = do
  provider <- allocateParty "Provider"
  user <- allocateParty "User"

  -- Create proposal
  requestCid <- submit user do
    createCmd AppInstallRequest with
      provider; user; meta = Metadata (Map.empty)

  -- Accept proposal
  installCid <- submit provider do
    exerciseCmd requestCid AppInstallRequest_Accept with
      installMeta = Metadata (Map.empty)

  pure ()
```

---

## 6. Ledger API v2 / PQS / JSON API

### Ledger API v2 (gRPC) — Primary Interface

The cn-quickstart backend uses the **Ledger API v2** directly via gRPC:

```java
// LedgerApi.java (Spring Component)
public class LedgerApi {
    // Constructor: establishes gRPC channel with auth interceptors
    public LedgerApi(LedgerConfig config, TokenProvider tokenProvider, AuthUtils auth) {
        this.channel = ManagedChannelBuilder.forAddress(host, port)
            .intercept(new AuthInterceptor(tokenProvider))
            .build();
    }

    // Create a contract
    public CompletableFuture<String> create(Object template) { ... }

    // Exercise a choice and get the result
    public CompletableFuture<Object> exerciseAndGetResult(
        ContractId cid, Object choice, String commandId) { ... }

    // Submit arbitrary commands
    public CompletableFuture<Void> submitCommands(List<Command> commands) { ... }
}
```

### PQS (Participant Query Store) — SQL-Based Queries

PQS mirrors ledger state into a Postgres database, enabling SQL queries:

```java
// DamlRepository.java
public class DamlRepository {
    // Queries active contracts via PQS (Postgres)
    public CompletableFuture<List<LicenseWithRenewalRequests>> findActiveLicenses(String party) {
        // Complex SQL joins across License, LicenseRenewalRequest, and Allocation tables
        // PQS automatically maintains these tables from ledger events
    }

    public CompletableFuture<Optional<License>> findLicenseById(String contractId) { ... }
}
```

**PQS Architecture:**
- Runs as a separate service alongside the participant
- Subscribes to the participant's transaction stream
- Materializes contract state into Postgres tables
- Apps query Postgres directly for reads, use Ledger API for writes
- Multiple PQS instances per participant (one per app/tenant)

### Application Configuration

```yaml
# application.yml
ledger:
  application-id: ${AUTH_APP_PROVIDER_BACKEND_USER_ID:AppId}
  registry-base-uri: ${REGISTRY_BASE_URI}  # Splice token standard endpoint

application:
  tenants:
    AppProvider:
      tenantId: AppProvider
      partyId: ${APP_PROVIDER_PARTY}
      internal: true
```

---

## 7. Frontend Integration Patterns

### cn-quickstart Frontend

- **Framework**: Vite + TypeScript (no Next.js — lighter weight)
- **Pattern**: Backend-for-Frontend (BFF)
  - Frontend calls REST API (Spring Boot backend)
  - Backend translates to Ledger API gRPC calls
  - Frontend NEVER talks to Ledger API directly
- **Auth**: OAuth2 via Keycloak (redirect flow) or shared-secret (dev mode)
- **Wallet**: External wallet app (Splice wallet) for CC payments
  - Wallet URL configured per tenant
  - Frontend redirects to wallet for payment approval
  - Wallet redirects back after allocation

### Wallet Integration Pattern

```typescript
// When user needs to pay for a license renewal:
// 1. Frontend shows the renewal request
// 2. User clicks "Pay" → redirected to Splice wallet URL
// 3. Wallet shows allocation request (amount in CC)
// 4. User approves → wallet creates allocation
// 5. Wallet redirects back to app
// 6. Provider calls CompleteRenewal with allocation CID
```

### Integration Test Pattern (Playwright)

```typescript
// workflow.spec.ts — Full License Lifecycle test
test('Full License Lifecycle should pass', async ({ provider, user, keycloak }) => {
    // Step 1: Provider accepts install request, creates license
    await provider.installs.goto();
    await provider.installs.withRowMatching(requestTag, async () => {
        await provider.installs.clickButton(InstallButton.Accept);
        await provider.installs.clickButton(InstallButton.CreateLicense);
        licenseId = await provider.installs.captureLicenseId();
    });

    // Step 2: Provider initiates renewal
    await provider.licenses.renewalsModal.issueRenewalModal
        .clickButton(IssueRenewalModalButton.IssueLicenseRenewalRequest);

    // Step 3: User onboards wallet, taps funds, pays
    await user.wallet.onboardWalletUser(keycloak, userId, partyId);
    await user.wallet.tap(1000);  // Faucet CC on DevNet
    await wallet.acceptAllocationRequest(100, renewalReason, renewalRequestId);

    // Step 4: Provider completes renewal
    await renewals.clickButton(RenewalsModalButton.CompleteRenewal);
});
```

---

## 8. Infrastructure & Deployment

### Docker Compose Architecture (cn-quickstart)

```
Services:
├── Splice LocalNet (dev mode)
│   ├── canton (participant + sequencer + mediator)
│   ├── splice-sv (Super Validator app)
│   └── splice-wallet (Wallet app)
├── Application
│   ├── backend-service (Spring Boot)
│   ├── nginx (reverse proxy + frontend)
│   └── register-app-user-tenant (onboarding)
├── Infrastructure
│   ├── pqs-app-provider (PQS for provider)
│   ├── pqs-app-user (PQS for user, optional)
│   ├── keycloak (OAuth2, optional)
│   └── splice-onboarding (DAR upload)
└── Observability (optional)
    ├── grafana
    ├── prometheus
    ├── opentelemetry-collector
    └── cadvisor
```

### Build System (Gradle + Make)

```makefile
# Key Make targets
make build           # Build everything (frontend + backend + DAML + Docker)
make start           # Start all services
make stop            # Stop all services
make test            # Run DAML tests
make integration-test # Run Playwright E2E tests
make setup           # Configure local env (DevNet/LocalNet, auth mode)
make canton-console  # Interactive Canton console
make shell           # Daml Shell (interactive DAML REPL)
```

### Key Environment Variables

```env
SPLICE_VERSION=0.5.12           # Splice release version
AUTH_MODE=oauth2                 # or shared-secret
PARTY_HINT=quickstart-1         # Participant party hint
APP_PROVIDER_PARTY=...          # Provider party ID
BACKEND_PORT=8080               # Backend API port
REGISTRY_BASE_URI=...           # Splice token standard registry
```

### Reference: Secure Canton Infrastructure

`digital-asset/ex-secure-canton-infra` provides production patterns:
- PKI (Public Key Infrastructure) for TLS
- JWT authentication for API access
- High Availability (HA) deployment
- Shell scripts for certificate management

---

## 9. Gap Analysis — Minted mUSD vs Canton-Native

### What We Do Well (Keep)

| Pattern | Status | Notes |
|---------|--------|-------|
| Propose-Accept transfers | Correct | All token transfers use dual-signatory proposals |
| Compliance gating | Correct | ComplianceRegistry validation on all operations |
| Nonconsuming read choices | Correct | Oracle queries, governance checks |
| Audit trail (immutable receipts) | Correct | MintAuditReceipt, BurnAuditReceipt, etc. |
| Supply cap management | Correct | Global + local caps, large mint pre-approval |
| Rate limiting with proportional decay | Correct | Prevents window-boundary attacks |
| Bridge attestation security | Correct | ValidatorSelfAttestation prevents forgery |
| Separate bridge nonces | Correct | CRIT-05 fix applied |

### What Needs to Change

| Issue | Current State | Canton-Native Pattern |
|-------|--------------|----------------------|
| **No DAML interfaces** | All templates are concrete, no `interface` keyword used | Modern Canton apps use interfaces for pluggable behavior (`IAsset`, `ITransferable`) |
| **Closed CollateralType enum** | `data CollateralType = CTN_Coin \| CTN_USDC \| ...` — adding a type requires package upgrade | Should be interface-based: any template implementing `ICollateral` can be deposited |
| **Per-asset bespoke choices** | `Lending_DepositCTN`, `Lending_DepositUSDC`, etc. (5 deposits, 5 withdrawals, 5 liquidation branches) | Single generic `Lending_Deposit` operating on `ICollateral` interface |
| **No Splice token standard integration** | Custom token templates with no Splice API compatibility | Should implement `splice_api_token_holding_v1` interfaces for wallet/payment integration |
| **No PQS integration** | Backend queries via... (not clear, likely direct Ledger API) | cn-quickstart pattern: PQS (Postgres) for reads, Ledger API for writes |
| **V3 monolith** | 84KB single file with 14 templates | Should split by domain: `Bridge.daml`, `Vault.daml`, `Token.daml`, `Oracle.daml` |
| **Duplicate implementations** | CantonMUSD (standalone) AND MintedMUSD (V3) — parallel implementations | Consolidate into single canonical template per concept |
| **Contract key reliance** | Several templates use `lookupByKey` patterns | LF 2.x: pass `ContractId` explicitly, avoid `lookupByKey` for critical paths |
| **Build system** | `daml build` / `daml test` directly | Canton-native: Gradle wrapping DAML build (`./gradlew :daml:build`) |
| **No multi-tenant architecture** | Single operator model | Should support multi-tenant: provider + multiple user parties with separate PQS |
| **Frontend: Next.js 15** | Heavy framework | cn-quickstart uses Vite (lighter), but this is a preference, not a blocker |

### Critical Missing Pieces

1. **Splice Token Standard Compliance**
   - mUSD should implement Splice token interfaces so it can be held in Splice wallets
   - Payments/fees should flow through the Splice allocation mechanism
   - This enables mUSD to be a first-class citizen on Canton Network

2. **Interface-Based Collateral System**
   - Define `ICollateral` interface with `getAmount`, `getOwner`, `archive`
   - Any RWA template implementing `ICollateral` can be deposited as collateral
   - CollateralConfig becomes runtime data, not compile-time sum type

3. **PQS Integration**
   - The relay and bot services should query PQS (Postgres) instead of polling the Ledger API
   - Enables efficient SQL queries for liquidation monitoring, TVL tracking, etc.

---

## 10. Recommendations — What Changes

### Phase 1: Interface Layer (High Impact, Medium Effort)

**Goal**: Make collateral pluggable so new RWA types can onboard without package upgrades.

```daml
-- New file: daml/Interfaces.daml

interface ICollateralToken where
  viewtype CollateralView
  getOwner : Party
  getAmount : Decimal
  getIssuer : Party

  -- Archive the token (consume it as collateral)
  choice ICollateral_Archive : ()
    controller (view this).owner, (view this).issuer
    do pure ()

data CollateralView = CollateralView
  { owner : Party
  , amount : Decimal
  , issuer : Party
  , assetClass : Text    -- "CTN_Coin", "TBill_XYZ", etc.
  }

-- Each token template implements the interface
template CantonCoin
  ...
  interface instance ICollateralToken for CantonCoin where
    view = CollateralView owner amount issuer "CTN_Coin"
    getOwner = owner
    getAmount = amount
    getIssuer = issuer

-- CantonLendingService gets ONE generic deposit choice
nonconsuming choice Lending_Deposit : (ContractId CantonLendingService, ContractId EscrowedCollateral)
  with
    user : Party
    collateralCid : ContractId ICollateralToken
    collateralType : Text    -- matches CollateralConfig key
  controller user
  do
    colView <- exercise collateralCid GetView
    -- Validate against CollateralConfig registry
    -- Archive the token
    -- Create EscrowedCollateral
```

### Phase 2: Splice Token Standard (High Impact, High Effort)

**Goal**: Make mUSD holdable in Splice wallets and payable via the token standard.

```daml
-- mUSD implements Splice holding interface
import Splice.Api.Token.HoldingV1

template CantonMUSD
  ...
  interface instance Splice.Api.Token.HoldingV1.Holding for CantonMUSD where
    view = HoldingView
      { instrumentId = InstrumentId operator "mUSD"
      , owner = owner
      , amount = amount
      }
```

### Phase 3: Module Decomposition (Medium Impact, Low Effort)

Split V3.daml (84KB) into:

```
daml/Minted/Protocol/
├── Token.daml        — MintedMUSD, transfer proposals
├── Vault.daml        — Vault, VaultManager, VaultConfig
├── Bridge.daml       — BridgeService, attestations, bridge requests
├── Oracle.daml       — PriceOracle
├── Pool.daml         — LiquidityPool
├── Supply.daml       — MUSDSupplyService
├── Governance.daml   — GovernanceConfig, MultiSigProposal, MinterRegistry
└── Types.daml        — Shared data types, type aliases
```

### Phase 4: PQS + Backend Modernization (Medium Impact, Medium Effort)

- Deploy PQS alongside each participant
- Relay service queries PQS for pending bridge operations
- Liquidation bot queries PQS for unhealthy vaults
- Frontend backend uses PQS for all read queries

### Phase 5: Build System Alignment (Low Impact, Low Effort)

- Wrap `daml build`/`daml test` in Gradle (following cn-quickstart)
- Add Makefile targets matching cn-quickstart conventions
- Docker Compose modular structure

---

## 11. RWA Collateral Onboarding Path

### Current State (Hard)

Adding a new collateral type today requires:
1. Add variant to `CollateralType` sum type → **DAML package upgrade**
2. Write `Lending_Deposit<X>` choice (~40 lines)
3. Write `Lending_Withdraw<X>` choice (~60 lines)
4. Add liquidation branch (~20 lines)
5. Import their template module
6. Deploy price feed
7. Redeploy everything

### Future State (After Interface Layer)

Adding a new collateral type:
1. Institution deploys their DAML template that `implements ICollateralToken` → **no Minted package change**
2. Governance adds a `CollateralConfig` entry (LTV, threshold, penalty) → **runtime config**
3. Deploy price feed for the asset
4. Done — users can deposit the new collateral immediately

### How It Works for an Institution Bringing a T-Bill Template

```daml
-- Institution's template (their package, their deploy)
module Institution.TBill where

import Minted.Interfaces (ICollateralToken, CollateralView)

template TokenizedTBill
  with
    issuer : Party          -- The institution
    owner : Party           -- Current holder
    amount : Decimal        -- Face value in USD
    cusip : Text            -- CUSIP identifier
    maturityDate : Date     -- Bond maturity
  where
    signatory issuer, owner

    -- Implements our interface — this is the contract
    interface instance ICollateralToken for TokenizedTBill where
      view = CollateralView
        { owner = owner
        , amount = amount
        , issuer = issuer
        , assetClass = "TBILL_" <> cusip
        }
      getOwner = owner
      getAmount = amount
      getIssuer = issuer
```

**Then on our side:**

```daml
-- Governance proposal to add new collateral type
-- No code changes needed — just a config update
exercise governanceServiceCid AddCollateralConfig with
  assetClass = "TBILL_912828ZT"
  config = CollateralConfig
    { ltvBps = 9000          -- 90% LTV (T-Bills are very safe)
    , liquidationThreshold = 9500  -- 95%
    , liquidationPenaltyBps = 200  -- 2% penalty
    , staleness = seconds 3600     -- 1 hour price staleness
    , isActive = True
    }
```

### What the Institution Needs to Do

1. Write their DAML template (they likely already have one)
2. Add `implements ICollateralToken` with the view mapping
3. Deploy their DAR to their Canton participant
4. Work with us on price feed integration
5. Apply for collateral approval through governance

### What We Need to Do

1. **One-time**: Build the interface layer (Phase 1 above)
2. **Per asset**: Add `CollateralConfig` via governance vote
3. **Per asset**: Set up price feed (can be their oracle or our aggregated one)
4. **Per asset**: Compliance review (existing ComplianceRegistry handles this)

---

## Key Repositories Reference

| Repo | URL | Relevance |
|------|-----|-----------|
| Canton Protocol | `digital-asset/canton` | Core protocol, Scala, v3.4.11 |
| cn-quickstart | `digital-asset/cn-quickstart` | **Primary reference app** |
| Splice | `hyperledger-labs/splice` | Global Synchronizer, Amulet, Token Standard |
| Splice Releases | `digital-asset/decentralized-canton-sync` | Release distribution, v0.5.12 |
| Secure Canton Infra | `digital-asset/ex-secure-canton-infra` | Production PKI/JWT/HA patterns |
| xReserve Deposits | `digital-asset/xreserve-deposits` | Ethereum→Canton USDC bridge reference |
| DAML SDK | `digital-asset/daml` | Language SDK, v2.10.3 |
| Daml Finance | `digital-asset/daml-finance` | Token/asset model library |

---

## Summary

The Minted mUSD Protocol is **architecturally sound** but **not yet Canton-native**. The core financial logic (vaults, liquidation, supply caps, compliance, attestations) is solid and battle-tested. What's missing is the integration layer that makes it a first-class citizen of the Canton Network ecosystem:

1. **DAML interfaces** for pluggable collateral (biggest win for RWA onboarding)
2. **Splice token standard** compliance (biggest win for network adoption)
3. **PQS integration** for efficient off-ledger queries
4. **Module decomposition** for maintainability

The good news: these are **additive changes**, not rewrites. The existing templates continue to work. Interfaces can be added incrementally. Splice integration can layer on top. The vault math, compliance gating, and bridge security don't change — they're already right.

**Bottom line for the original question**: Once the interface layer is in place, accepting a new institution's custom RWA template as collateral becomes a governance config change + price feed setup — no code deployment on our side needed.
