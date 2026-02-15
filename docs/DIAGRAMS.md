# Minted mUSD Protocol - State Machines & Flow Diagrams

This document contains Mermaid diagrams for the protocol's state machines and transaction flows.

---

## 1. mUSD Token Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Minted: DirectMint.deposit() / Bridge.receiveAttestation()
    
    Minted --> Active: User holds mUSD
    Active --> Staked: SMUSD.deposit()
    Staked --> Active: SMUSD.withdraw()
    Active --> Collateral: CollateralVault.deposit()
    Collateral --> Active: CollateralVault.withdraw()
    Active --> Bridged: BLEBridgeV9.bridgeToCanton()
    Bridged --> Active: BLEBridgeV9.receiveFromCanton()
    Active --> Burned: DirectMint.redeem()
    Burned --> [*]
    
    Active --> Blacklisted: MUSD.blacklist()
    Blacklisted --> Active: MUSD.unblacklist()
```

---

## 2. DirectMint Flow

```mermaid
sequenceDiagram
    participant User
    participant DirectMintV2
    participant USDC
    participant MUSD
    participant TreasuryV2

    User->>USDC: approve(DirectMintV2, amount)
    User->>DirectMintV2: mint(amount)
    
    DirectMintV2->>DirectMintV2: Check rate limit
    DirectMintV2->>DirectMintV2: Check supply cap
    DirectMintV2->>USDC: transferFrom(user, treasury, amount)
    DirectMintV2->>TreasuryV2: deposit(usdc, amount)
    DirectMintV2->>MUSD: mint(user, amount - fee)
    DirectMintV2->>MUSD: mint(feeRecipient, fee)
    DirectMintV2-->>User: mUSD tokens
```

---

## 3. Bridge Attestation Flow (Canton → Ethereum)

```mermaid
sequenceDiagram
    participant Canton
    participant Validator1
    participant Validator2
    participant Validator3
    participant RelayService
    participant BLEBridgeV9
    participant MUSD

    Canton->>Canton: User burns CantonMUSD
    Canton->>Canton: Create AttestationRequest
    
    Validator1->>Canton: Sign attestation
    Validator2->>Canton: Sign attestation
    Validator3->>Canton: Sign attestation
    
    Canton->>Canton: Quorum reached (3-of-5)
    Canton->>RelayService: Finalized attestation event
    
    RelayService->>RelayService: Convert DER → RSV signatures
    RelayService->>BLEBridgeV9: submitAttestation(payload, signatures)
    
    BLEBridgeV9->>BLEBridgeV9: Verify signatures
    BLEBridgeV9->>BLEBridgeV9: Check nonce (replay protection)
    BLEBridgeV9->>BLEBridgeV9: Check rate limit
    BLEBridgeV9->>BLEBridgeV9: Update attestedCantonAssets
    BLEBridgeV9->>MUSD: updateSupplyCap(newCap)
    BLEBridgeV9-->>RelayService: Success
```

---

## 4. Vault Liquidation Flow

```mermaid
sequenceDiagram
    participant Liquidator
    participant LiquidationEngine
    participant BorrowModule
    participant CollateralVault
    participant PriceOracle
    participant MUSD

    Liquidator->>LiquidationEngine: liquidate(vaultId, repayAmount)
    
    LiquidationEngine->>BorrowModule: getPosition(vaultId)
    LiquidationEngine->>PriceOracle: getPrice(collateralToken)
    LiquidationEngine->>LiquidationEngine: Calculate health factor
    
    alt Health Factor < 1.0
        LiquidationEngine->>MUSD: transferFrom(liquidator, address(this), repayAmount)
        LiquidationEngine->>MUSD: burn(repayAmount)
        LiquidationEngine->>BorrowModule: reduceDebt(vaultId, repayAmount)
        LiquidationEngine->>LiquidationEngine: Calculate seizure + penalty
        LiquidationEngine->>CollateralVault: seize(vaultId, collateralAmount, liquidator)
        LiquidationEngine-->>Liquidator: Collateral + bonus
    else Health Factor >= 1.0
        LiquidationEngine-->>Liquidator: Revert: NOT_LIQUIDATABLE
    end
```

---

## 5. Governance Proposal Flow (DAML)

```mermaid
stateDiagram-v2
    [*] --> Proposed: Governor creates MultiSigProposal
    
    Proposed --> Proposed: Governor approves (< threshold)
    Proposed --> Approved: Approval threshold met
    Proposed --> Rejected: Rejection threshold met
    Proposed --> Expired: expiresAt passed
    
    Approved --> Timelocked: 24h timelock starts
    Timelocked --> Executed: Executor calls Proposal_Execute
    Timelocked --> Expired: Timelock + grace period passed
    
    Rejected --> [*]
    Expired --> [*]
    Executed --> [*]
```

---

## 6. Contract Upgrade Flow (DAML)

```mermaid
sequenceDiagram
    participant Operator
    participant Governance
    participant UpgradeProposal
    participant UpgradeRegistry
    participant MigrationTicket
    participant User

    Operator->>UpgradeProposal: Create proposal (V2 → V3)
    
    loop Until threshold met
        Governance->>UpgradeProposal: Approve
    end
    
    UpgradeProposal->>UpgradeProposal: Status = Approved
    
    Note over Operator: Wait for activation delay
    
    Operator->>UpgradeProposal: Activate
    UpgradeProposal->>UpgradeRegistry: Create registry
    
    User->>MigrationTicket: Request migration
    Operator->>MigrationTicket: Execute migration
    MigrationTicket->>UpgradeRegistry: Record migration
    MigrationTicket-->>User: New V3 contracts
```

---

## 7. smUSD Yield Flow (2-Vault Architecture)

```mermaid
flowchart TD
    A[User deposits mUSD] --> B[smUSD vault]
    B --> C[TreasuryV2]
    
    C --> V1["Vault #1 — Diversified Loop (MetaVault)"]
    C --> V2["Vault #2 — Primary Yield (MetaVault)"]
    C --> R[Idle USDC Reserve]
    
    V1 --> S1[EulerV2 Cross-Stable Loop]
    V1 --> S2[Aave V3 Loop]
    V1 --> S3[Compound V3 Loop]
    V1 --> S4[Contango Perp Loop]
    V1 --> S5[Sky sUSDS]
    
    V2 --> S6[Fluid Loop #146]
    V2 --> S7[Pendle PT Markets]
    V2 --> S8[Morpho Blue Loop]
    V2 --> S9[Euler V2 Loop]
    
    S1 --> Y[Yield Generated]
    S2 --> Y
    S3 --> Y
    S4 --> Y
    S5 --> Y
    S6 --> Y
    S7 --> Y
    S8 --> Y
    S9 --> Y
    
    Y --> J[Treasury records return]
    J --> K[smUSD share price increases]
    K --> L[User withdraws more mUSD]
```

---

## 8. Compliance Check Flow

```mermaid
flowchart TD
    A[Transfer Request] --> B{Sender Blacklisted?}
    B -->|Yes| C[Reject: SENDER_BLACKLISTED]
    B -->|No| D{Sender Frozen?}
    
    D -->|Yes| E[Reject: SENDER_FROZEN]
    D -->|No| F{Receiver Blacklisted?}
    
    F -->|Yes| G[Reject: RECEIVER_BLACKLISTED]
    F -->|No| H[Transfer Allowed]
    
    H --> I[Create TransferProposal]
    I --> J[Receiver accepts]
    J --> K[Transfer Complete]
```

---

## 9. Rate Limiting State Machine

```mermaid
stateDiagram-v2
    [*] --> Ready: Contract deployed
    
    Ready --> Processing: Mint/Bridge request
    
    Processing --> Ready: Within daily limit
    Processing --> RateLimited: Exceeds daily limit
    
    RateLimited --> Ready: 24h window resets
    
    note right of RateLimited
        User must wait for window reset
        or reduce request amount
    end note
```

---

## 10. Emergency Pause Flow

```mermaid
sequenceDiagram
    participant Guardian
    participant Contract
    participant Users

    Note over Guardian: Incident detected
    
    Guardian->>Contract: pause()
    Contract->>Contract: paused = true
    Contract-->>Users: All state-changing functions revert
    
    Note over Guardian: Investigate and remediate
    
    alt Issue resolved
        Guardian->>Contract: unpause()
        Contract->>Contract: paused = false
        Contract-->>Users: Normal operations resume
    else Requires upgrade
        Guardian->>Contract: Prepare upgrade
        Guardian->>Contract: Execute upgrade
        Guardian->>Contract: unpause()
    end
```

---

## Viewing These Diagrams

These Mermaid diagrams render automatically on:
- GitHub (in markdown files)
- VS Code with Mermaid extension
- Mermaid Live Editor: https://mermaid.live

For PDF export, use the Mermaid CLI:
```bash
npm install -g @mermaid-js/mermaid-cli
mmdc -i docs/DIAGRAMS.md -o docs/diagrams.pdf
```
