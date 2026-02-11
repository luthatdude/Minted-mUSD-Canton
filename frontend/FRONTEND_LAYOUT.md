# Minted Protocol — Frontend Layout Specification

> Design reference for the complete site layout, navigation, page structure, and component hierarchy.

---

## Global Shell

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  NAVBAR  (sticky top, glass blur, z-50)                                     │
│  ┌──────────┬────────────────────────────────────────┬───────────────────┐   │
│  │  Logo    │  Navigation Tabs                       │  Right Controls   │   │
│  │  Minted  │  Dashboard · Mint · Stake ·            │  [ETH ⟷ Canton]  │   │
│  │  Protocol│  Borrow & Lend · Bridge · Admin        │  [0x1a2b…3c4d]   │   │
│  └──────────┴────────────────────────────────────────┴───────────────────┘   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  MAIN CONTENT AREA  (max-w-7xl, px-4/6/8, py-8)                            │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                                                                      │    │
│  │               << Active Page Renders Here >>                         │    │
│  │                                                                      │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  FOOTER  (border-t, text-gray-500)                                          │
│  ● All systems operational          Docs · GitHub · Discord    © 2026 Minted│
└──────────────────────────────────────────────────────────────────────────────┘
```

### Background
- Dark surface (`bg-surface-950`) with animated gradient orbs (top-left blue, bottom-right purple)
- Subtle cross-hatch SVG grid at 2% opacity
- Orb colors swap to emerald when on Canton chain

### Chain Toggle
- Pill toggle in the navbar: **Ethereum** (blue/brand) ⟷ **Canton** (emerald/green)
- Entire app swaps between Ethereum pages and Canton pages based on selection
- Navbar active-tab underline color follows chain (brand-500 vs emerald-500)

### Mobile
- Hamburger button replaces nav tabs at `< lg` breakpoint
- Slide-down menu with full-width nav items

---

## Navigation Items

| Key         | Label          | Icon                | Page Component (ETH)  | Page Component (Canton)  |
|-------------|----------------|---------------------|-----------------------|--------------------------|
| `dashboard` | Dashboard      | Home                | `DashboardPage`       | `CantonDashboard`        |
| `mint`      | Mint           | Dollar circle       | `MintPage`            | `CantonMint`             |
| `stake`     | Stake          | Trending up         | `StakePage`           | `CantonStake`            |
| `borrow`    | Borrow & Lend  | Building            | `BorrowPage`          | `CantonBorrow`           |
| `bridge`    | Bridge         | Arrows left-right   | `BridgePage`          | `CantonBridge`           |
| `admin`     | Admin          | Settings gear       | `AdminPage`           | `CantonAdmin`            |
| `points`    | Points         | Star                | `PointsPage`          | `PointsPage`             |

---

## Page Layouts

Every page follows this structure:

```
┌──────────────────────────────────────────────────────┐
│  PageHeader                                           │
│  Title · Subtitle · Badge                             │
├──────────────────────────────────────────────────────┤
│  Alert Banner (conditional)                           │
├──────────────────────────────────────────────────────┤
│  StatCard Grid  (2-4 columns)                         │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐     │
│  │ Icon   │  │ Icon   │  │ Icon   │  │ Icon   │     │
│  │ Label  │  │ Label  │  │ Label  │  │ Label  │     │
│  │ Value  │  │ Value  │  │ Value  │  │ Value  │     │
│  │ Sub    │  │ Sub    │  │ Trend  │  │ Sub    │     │
│  └────────┘  └────────┘  └────────┘  └────────┘     │
├──────────────────────────────────────────────────────┤
│  Feature Card(s) — gradient border                    │
│  (position overview, gauges, tables, etc.)            │
├──────────────────────────────────────────────────────┤
│  Action Card — gradient border                        │
│  ┌─ Tab Bar ────────────────────────────────────┐    │
│  │  [Tab1]  [Tab2]  [Tab3]  [Tab4]              │    │
│  ├──────────────────────────────────────────────┤    │
│  │  Input Field (emerald/brand glow on focus)   │    │
│  │  ┌──────────────────────── [MAX] [Token] ┐   │    │
│  │  │  0.00                                  │   │    │
│  │  └────────────────────────────────────────┘   │    │
│  │           ↓  (arrow separator)                │    │
│  │  Output Preview                               │    │
│  │  ┌────────────────────────────── [Token] ┐   │    │
│  │  │  0.00                                  │   │    │
│  │  └────────────────────────────────────────┘   │    │
│  │  Exchange Info Panel                          │    │
│  │  [ ====== Action Button (full width) ====== ]│    │
│  │  Alert: success / error                       │    │
│  └──────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────┤
│  Info Section — "How It Works" (step cards)           │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐             │
│  │ ① …  │  │ ② …  │  │ ③ …  │  │ ④ …  │             │
│  └──────┘  └──────┘  └──────┘  └──────┘             │
└──────────────────────────────────────────────────────┘
```

---

### 1. Dashboard Page (`/dashboard`)

```
PageHeader: "Protocol Dashboard" · badge: chain name

┌─ Portfolio / Protocol toggle tabs ──────────────────────┐

PORTFOLIO TAB:
  ┌──────────────────────────────────────────────────────┐
  │  Net Worth Banner  (card-gradient-border)             │
  │  $XX,XXX.XX total · mUSD / smUSD / Collateral / Debt │
  │  Health Factor badge (if borrowing)                   │
  │  Liquidation warning (if at risk)                     │
  └──────────────────────────────────────────────────────┘

  4 StatCards:
    • mUSD Balance       (blue)
    • smUSD Balance       (purple, subValue = mUSD equivalent)
    • Collateral Value    (green)
    • Outstanding Debt    (red if > 0)

  Position Breakdown:
    Token table — symbol, amount, USD value

PROTOCOL TAB:
  4 StatCards:
    • Total mUSD Supply   (brand)
    • Supply Cap Usage     (utilization bar)
    • Treasury Backing     (green)
    • Vault TVL            (blue)

  Protocol Metrics grid:
    • Attested Canton Assets, Bridge Health, Collateral Ratio
    • Mint Fee, Redeem Fee, Interest Rate
    • Bridge status, Available reserves, Strategies deployed
```

---

### 2. Mint Page (`/mint`)  — max-w-3xl

```
PageHeader: "Mint & Redeem" · "Direct USDC ↔ mUSD" · badge "1:1 Peg"

4 StatCards (sm:2 lg:4):
  • Mint Fee         (formatBps)
  • Redeem Fee       (formatBps)
  • Remaining Mintable (formatUSD)
  • Available for Redemption (formatUSD)

2 Balance Cards (sm:2):
  • Your USDC Balance
  • Your mUSD Balance

Action Card (card-gradient-border):
  ┌─ [Mint USDC → mUSD]  [Redeem mUSD → USDC] ─────────┐
  │                                                        │
  │  Cross-chain source selector (optional Arbitrum/OP)    │
  │                                                        │
  │  Input:  amount  [MAX] [USDC/mUSD badge]               │
  │              ↓                                         │
  │  Output: preview  [mUSD/USDC badge]                    │
  │                                                        │
  │  Exchange info (rate, fee, min/max)                     │
  │  [ ====== Mint mUSD / Redeem USDC button ========== ] │
  │  Success/Error alerts with Etherscan link               │
  └────────────────────────────────────────────────────────┘

"How It Works" Explainer Card:
  "Mint mUSD 1:1 against selected collateral, validated in real time by
  attestations on the Canton Network, then stake to begin earning."
```

---

### 3. Stake Page (`/stake`)  — max-w-3xl

```
PageHeader: "Stake & Earn" · "ERC-4626 vault" · badge "ERC-4626" (emerald)

4 StatCards (sm:2 lg:4):
  • Share Price        (X.XXXX mUSD per smUSD, green)
  • Estimated APY      (X.XX%, green, trend arrow)
  • Total Vault TVL    (X mUSD, blue)
  • Total smUSD Supply (purple)

Your Position Card (card-gradient-border, only if smUSD > 0):
  ┌───────────────────────────────────────────────────┐
  │  📊 Your Position — Staking performance overview   │
  │  ┌──────────────┬──────────────┬──────────────┐   │
  │  │ smUSD Balance│ Position Val │ Yield Earned │   │
  │  │    XX.XX     │  XX.XX mUSD  │ +X.XX mUSD   │   │
  │  └──────────────┴──────────────┴──────────────┘   │
  └───────────────────────────────────────────────────┘

Cooldown Timer (card, only if cooldown active):
  ┌───────────────────────────────────────────────────┐
  │  ⏱ Withdrawal Cooldown      [XX% Complete badge]  │
  │  X.X hours remaining                               │
  │  [███████████████░░░░░░░░░░░]  progress bar        │
  └───────────────────────────────────────────────────┘

2 Balance Cards (sm:2):
  • Your mUSD Balance (blue)
  • Your smUSD Balance (purple, sub = ≈ X.XX mUSD)

Action Card (card-gradient-border):
  ┌─ [➕ Stake mUSD]  [🔄 Unstake smUSD] ───────────────┐
  │                                                        │
  │  Input:  amount  [MAX] [mUSD/smUSD badge]              │
  │              ↓                                         │
  │  Output: preview  [smUSD/mUSD badge]                   │
  │                                                        │
  │  Exchange info (rate, cooldown, fee=None)               │
  │  Cooldown warning (if unstake + cooldown active)        │
  │  [ ====== Stake mUSD / Unstake smUSD ============== ] │
  │  Success/Error alerts with Etherscan link               │
  └────────────────────────────────────────────────────────┘

"How Staking Works" — 3 step cards:
  ① Deposit mUSD → ② Earn Yield → ③ Withdraw Anytime

"AI Yield Aggregation Engine" Explainer Card:
  Staking distributes generated yield exclusively to mUSD stakers, using our
  AI yield aggregation engine. The AI deliberates across hundreds of protocols
  in Web3 using a proprietary algorithm — Highest Yield, Pool Liquidity,
  Weighted Performance Over Time, Security/Risk Profile, Oracle Stability, Curators.

CantonStake — Additional Canton-Only Widget:
  ┌─── Stake Canton Coin (Boost Pool) ──────────────────┐
  │  Explainer: "Stake 20% of your mUSD stake in Canton │
  │  Coin to receive boosted yield of 2-4% PLUS 60% of  │
  │  all validator rewards…"                             │
  │  3 StatCards: Boost Pool APY · Validator Rewards ·   │
  │  Points Multiplier                                    │
  │  Canton Coin Amount input                             │
  │  [Stake Canton Coin (Coming Soon)]                    │
  └──────────────────────────────────────────────────────┘
```

---

### 4. Borrow & Lend Page (`/borrow`)  — max-w-4xl

```
PageHeader: "Borrow & Lend" · badge dynamic "Active Position" (warning) / "No Position" (brand)

⚠ Liquidation Alert (red border-2, if liquidatable):
  ┌───────────────────────────────────────────────────┐
  │  🚨 Position At Risk of Liquidation               │
  │  [Emergency Repay ($XX)]  [Add Collateral]         │
  └───────────────────────────────────────────────────┘

⚠ Caution Warning (yellow alert, if HF < 1.2 but not liquidatable)

4 StatCards (sm:2 lg:4):
  • Total Collateral    (blue, 🔒 icon)
  • Outstanding Debt    (red if > 0, 📄 icon)
  • Available to Borrow (green, 💰 icon)
  • Interest Rate       (APR, 📈 icon)

Health Factor & Position Overview (card-gradient-border, only if debt > 0):
  ┌───────────────────────────────────────────────────┐
  │  ┌─── Health Factor ───┐  ┌── Position Summary ──┐│
  │  │  🛡 Health Factor    │  │  📊 Position Summary  ││
  │  │   2.45  (big, green) │  │  Collateral: $XX     ││
  │  │  [██████████░░░]     │  │  Debt:       $XX     ││
  │  │  Liq(1.0) Cau(1.5)  │  │  ─────────────       ││
  │  │       Safe(3.0+)    │  │  Net:        $XX     ││
  │  │  Status: Healthy     │  │  Utilization: XX%    ││
  │  │                      │  │                      ││
  │  │                      │  │  Your mUSD: $XX      ││
  │  │                      │  │  [Close Position]    ││
  │  └──────────────────────┘  └──────────────────────┘│
  └───────────────────────────────────────────────────┘

Collateral Positions Table (card):
  ┌───────────────────────────────────────────────────┐
  │  📦 Collateral Positions — X supported tokens      │
  │  ┌────────┬───────────┬──────┬──────┬──────┬─────┐│
  │  │ Token  │ Deposited │ USD  │ LTV  │ Liq. │ Pen.││
  │  │ [◉ W]  │   100.0   │ $XX  │ 80%  │ 85%  │ 5%  ││
  │  │ [◉ U]  │    50.0   │ $XX  │ 85%  │ 90%  │ 5%  ││
  │  └────────┴───────────┴──────┴──────┴──────┴─────┘│
  │  (LTV=brand badge, Threshold=yellow, Penalty=red)  │
  └───────────────────────────────────────────────────┘

Action Card (card-gradient-border):
  ┌─ [➕ Deposit] [💰 Borrow] [🔄 Repay] [⬆ Withdraw] [📈 Leverage] ─┐
  │                                                                      │
  │  ── Deposit/Borrow/Repay/Withdraw tabs ──                           │
  │  Token selector (deposit/withdraw only)                              │
  │  Input: amount [MAX] [Token badge]                                   │
  │  Hints: Max borrowable / Current debt                                │
  │  [ ====== Deposit / Borrow / Repay / Withdraw ===== ]               │
  │  Success/Error alerts with Etherscan link                            │
  │                                                                      │
  │  ── Leverage tab ──                                                  │
  │  Error banner (red, dismissible)                                     │
  │  4 StatCards: WETH Balance · Max Leverage · Position · Debt          │
  │  If no position:                                                     │
  │    WETH deposit input [MAX]                                          │
  │    LeverageSlider (1x-3x with presets)                               │
  │    Position Preview (collateral/debt/loops/leverage)                  │
  │    [Open X.Xx Leveraged Position]                                    │
  │  If has position:                                                    │
  │    Position grid: Deposit · Collateral · Debt · Leverage · Loops     │
  │    [Close Position & Repay Debt] (danger variant)                    │
  └────────────────────────────────────────────────────────────────────────┘

"How Borrowing Works" — 4 step cards:
  ① Deposit → ② Borrow → ③ Repay → ④ Withdraw

"Looping Strategies" — 2 strategy cards (sm:grid-cols-2):
  ┌─── sMUSD Maxi ─────────────────┐  ┌─── Canton Maxi ────────────────┐
  │  Low-Medium Risk                │  │  Medium Risk                    │
  │  Deposit → Mint → Stake → Loop  │  │  Deposit → Stake → Loop → Boost│
  │  APY table: 1x-4x loops         │  │  APY table: 1x-4x + Boost Pool │
  │  34-174% total APY               │  │  34-235% total APY              │
  └──────────────────────────────────┘  └─────────────────────────────────┘
```

---

### 5. Bridge Page (`/bridge`)  — max-w-4xl

```
PageHeader: "Canton Bridge" · badge dynamic "Active" (emerald) / "PAUSED" (warning)

⚠ Paused Alert (alert-error, if bridge paused)

4 StatCards (sm:2 lg:4):
  • Attested Canton Assets   (blue, glow variant, 🏢 icon)
  • Current Supply Cap       (purple, 📊 icon)
  • Remaining Mintable       (green, 💰 icon)
  • Last Attestation         (Xm/h ago, ⏱ icon, sub = timestamp)

Supply Cap & Health Ratio (2-col grid):
  ┌─── Supply Cap Utilization ───┐  ┌─── Bridge Health Ratio ──────┐
  │  (card-gradient-border)       │  │  (card-gradient-border)       │
  │  XX.X% of capacity used      │  │                                │
  │  [██████████████░░░░░]        │  │    1.85  (big, color-coded)   │
  │  Minted: $XX   Available: $XX │  │    "Healthy"                  │
  │                               │  │  [███████████████░░░]         │
  │                               │  │  1.0 ——— 1.5 ——— 2.0+        │
  └───────────────────────────────┘  └──────────────────────────────┘

Bridge Parameters (3-col grid, card):
  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
  │ Collateral Ratio│  │ Required Sigs  │  │ Current Nonce  │
  │     150%        │  │      3         │  │      42        │
  │  Overcollateral │  │ Multi-sig      │  │ Sequence #     │
  └────────────────┘  └────────────────┘  └────────────────┘

Attestation History Table (card):
  ┌───────────────────────────────────────────────────┐
  │  📋 Attestation History — X recent attestations    │
  │  ┌───────┬──────────────┬──────────┬────────┬────┐│
  │  │ Block │ Attestation  │ Canton   │ New    │Nonce││
  │  │ #1234 │ 0x1a2b…3c4d  │ Assets   │ Cap    │    ││
  │  └───────┴──────────────┴──────────┴────────┴────┘│
  │  (empty state: clipboard icon + "No attestations") │
  └───────────────────────────────────────────────────┘

"How the Bridge Works" — 6 step pipeline (3x2 or 6-col):
  ① Observe → ② Verify → ③ Sign → ④ Aggregate → ⑤ Update → ⑥ Mint
  (each with color-coded number circle: blue→purple→brand→emerald→yellow→green)

"Beneficiary Locked Environment (BLE)" Explainer Card:
  Move mUSD and sMUSD between Ethereum and Canton. Your yield never stops.
  Powered by Minted's proprietary BLE — a multi-sig attestation system where
  institutional validators verify every cross-chain transfer. No relayers,
  no optimistic windows. Every bridge action is cryptographically attested,
  validating assets on Canton, supply-cap enforced, and settled with finality.
```

---

### 6. Points Page (`/points`)

```
PageHeader: "Points Program" · "Earn points for using the protocol. Points convert to MNTD token airdrop." · badge: season name

Season Progress Bar (card):
  ┌───────────────────────────────────────────────────┐
  │  Season 1 — Genesis                               │
  │  2x multiplier · 45 days remaining                │
  │  [██████████████░░░░░░░░░░░░] 58% Complete        │
  │  ● Season 1 (active) · ○ Season 2 · ○ Season 3   │
  └───────────────────────────────────────────────────┘

Tab Nav: [Overview] [Leaderboard] [Calculator]

OVERVIEW TAB:
  Your Points (4 StatCards):
    • Total Points   (glow, blue)
    • Global Rank    (purple)
    • Current Season (default)
    • Seasons Active (green)

  Points Breakdown (card): per-action breakdown by season

  How It Works (card):
    "Your Points = USD Value × Multiplier × Hours"

  3 Seasons Multiplier Table:
    ┌──────────────┬──────────┬───────┬──────────┬────────┐
    │ Season       │ Boost    │ sMUSD │ Collat.  │ Borrow │
    │ 1 — Genesis  │ 10× 🔥   │ 4×    │ 3×       │ 2×     │
    │ 2 — Growth   │ 6×       │ 2.5×  │ 2×       │ 1.5×   │
    │ 3 — Maturity │ 4×       │ 1.5×  │ 1×       │ 1×     │
    └──────────────┴──────────┴───────┴──────────┴────────┘

  What Earns Points (2-col grid):
    Canton (higher multipliers): Stake mUSD, Deposit sMUSD/CTN, Borrow, Boost Pool
    Ethereum: Hold sMUSD, Deposit ETH/WBTC/sMUSD, Borrow, Leverage Vault

  Points APY by TVL (table):
    ┌──────────┬───────────────┬──────────────┬───────────────┐
    │ TVL      │ Boost Pool 🔥 │ sMUSD (CTN)  │ sMUSD (ETH)   │
    │ $5M      │ 354%          │ 142%         │ 106%          │
    │ $10M     │ 177%          │ 71%          │ 53%           │
    │ $25M     │ 71%           │ 28%          │ 21%           │
    │ $50M     │ 35%           │ 14%          │ 11%           │
    └──────────┴───────────────┴──────────────┴───────────────┘

  Maximize Your Points (4 tips):
    ① Get in early  ② Use Canton  ③ Loop your sMUSD  ④ Deposit $CC in Boost Pool

  Airdrop Section:
    Points → $MINT Tokens at TGE. Proportional to total points share.

LEADERBOARD TAB:
  Top 25 table: Rank · Address · Points (highlights user's own row)

CALCULATOR TAB:
  Implied APY (3 StatCards): APY · Token Price · Total Airdrop Value
  Scenarios Table: deposit · est. points · allocation · value · APY
  Multiplier Schedule: per-action cards with ETH/CTN badges
```

---

### 7. Admin Page (`/admin`)  — max-w-4xl

```
Tab bar: [mUSD] [DirectMint] [Treasury] [Bridge] [Borrow] [Oracle]

Each section shows:
  • Current on-chain values (read from contracts)
  • Input fields to update parameters
  • TxButton to submit transactions
  • Success/Error feedback

Sections:
  mUSD:       Supply cap, blacklist address
  DirectMint: Mint/redeem fees, fee recipient, min/max amounts, pause, collect fees
  Treasury:   Add/remove strategy, deploy/withdraw funds, max deployment BPS
  Bridge:     Min signatures, collateral ratio, emergency cap, pause
  Borrow:     Interest rate, min debt
  Oracle:     Set price feed (token, feed address, stale threshold, decimals)
```

---

## Design System

### Color Palette

| Token              | Value                         | Usage                          |
|--------------------|-------------------------------|--------------------------------|
| `surface-950`      | `#020617`                     | Page background                |
| `surface-900`      | `#0f172a`                     | Navbar, footer                 |
| `surface-800`      | `#1e293b`                     | Card interiors, inputs         |
| `surface-700`      | `#334155`                     | Borders, secondary bg          |
| `brand-400`        | `#60a5fa`                     | Primary accent (Ethereum mode) |
| `brand-500`        | `#338bff`                     | Buttons, links, active states  |
| `emerald-400/500`  | `#34d399` / `#10b981`         | Canton mode accent, success    |
| `purple-500`       | `#a855f7`                     | Secondary accent, gradients    |
| `red-400/500`      | Error, danger, liquidation    |                                |
| `yellow-400/500`   | Warning, caution              |                                |

### Card Variants

| Class                  | Description                                           |
|------------------------|-------------------------------------------------------|
| `.card`                | Glass card — rounded-2xl, border-white/10, gradient bg |
| `.card-glow`           | Card + animated gradient border glow                   |
| `.card-gradient-border`| Card with visible gradient top-border (brand→purple)   |
| `.card-emerald`        | Card with emerald gradient border (Canton mode)        |

### Button Variants

| Class           | Description                              |
|-----------------|------------------------------------------|
| `.btn-primary`  | Brand gradient bg, white text, glow      |
| `.btn-secondary`| Transparent, white/10 border, hover glow |
| `.btn-success`  | Emerald gradient                         |
| `.btn-danger`   | Red gradient                             |

### Input Style
```
rounded-xl border border-white/10 bg-surface-800/50 p-4
focus: border-brand-500/50 shadow-[0_0_20px_-5px_rgba(51,139,255,0.3)]
(Stake page uses emerald glow instead of brand)
```

### Badges

| Class           | Color            |
|-----------------|------------------|
| `.badge-brand`  | Blue/brand       |
| `.badge-emerald`| Green/emerald    |
| `.badge-warning`| Yellow/amber     |
| `.badge-danger` | Red              |

### Typography

| Element       | Style                                           |
|---------------|-------------------------------------------------|
| Page title    | `text-3xl sm:text-4xl font-bold text-white`     |
| Subtitle      | `text-lg text-gray-400`                         |
| Section title | `text-lg font-semibold text-white`              |
| Label         | `text-sm font-medium text-gray-400`             |
| Body          | `text-sm text-gray-300/400`                     |
| Stat value    | `text-2xl font-bold` (color varies)             |
| Big value     | `text-3xl–4xl font-bold` (health factors, etc.) |

---

## Component Hierarchy

```
Layout
├── Navbar
│   ├── Logo (Minted Protocol)
│   ├── NavItems × 7 (desktop)
│   ├── ChainToggle (ETH ⟷ Canton)
│   ├── Wallet Button / Connect Button
│   └── Mobile Menu (hamburger → slide-down)
│
├── Main Content (page router via useState)
│   ├── DashboardPage
│   │   ├── PageHeader
│   │   ├── Tab Toggle (Portfolio / Protocol)
│   │   ├── StatCard × 4
│   │   ├── Net Worth Card (gradient-border)
│   │   └── Position / Metrics grids
│   │
│   ├── MintPage
│   │   ├── PageHeader
│   │   ├── StatCard × 4
│   │   ├── Balance Cards × 2
│   │   ├── Action Card (mint/redeem tabs)
│   │   │   ├── ChainSelector (cross-chain)
│   │   │   ├── AmountInput + MAX + TokenBadge
│   │   │   ├── Arrow Separator
│   │   │   ├── OutputPreview
│   │   │   ├── ExchangeInfo
│   │   │   ├── TxButton
│   │   │   └── AlertStatus
│   │   ├── HowItWorks Explainer Card
│   │   └── Info Cards (Remaining Mintable + Available for Redemption)
│   │
│   ├── StakePage
│   │   ├── PageHeader (badge: ERC-4626)
│   │   ├── StatCard × 4
│   │   ├── YourPosition Card (gradient-border)
│   │   ├── CooldownTimer + progress bar
│   │   ├── Balance Cards × 2
│   │   ├── Action Card (stake/unstake tabs)
│   │   │   ├── AmountInput + MAX + TokenBadge
│   │   │   ├── Arrow Separator
│   │   │   ├── OutputPreview
│   │   │   ├── ExchangeInfo
│   │   │   ├── CooldownWarning
│   │   │   ├── TxButton
│   │   │   └── AlertStatus
│   │   ├── HowItWorks × 3
│   │   └── AI Yield Aggregation Explainer Card
│   │
│   ├── BorrowPage
│   │   ├── PageHeader (badge: Active/No Position)
│   │   ├── LiquidationAlert (conditional)
│   │   ├── CautionWarning (conditional)
│   │   ├── StatCard × 4
│   │   ├── HealthFactor + PositionSummary (gradient-border, 2-col)
│   │   ├── CollateralTable (token rows with badge pills)
│   │   ├── Action Card (deposit/borrow/repay/withdraw/leverage tabs)
│   │   │   ├── TokenSelector (deposit/withdraw)
│   │   │   ├── AmountInput + MAX + TokenBadge
│   │   │   ├── LeverageSlider + Position Preview (leverage tab)
│   │   │   ├── TxButton
│   │   │   └── AlertStatus
│   │   ├── HowItWorks × 4
│   │   └── LoopingStrategies × 2 (sMUSD Maxi + Canton Maxi)
│   │
│   ├── BridgePage
│   │   ├── PageHeader (badge: Active/PAUSED)
│   │   ├── PausedAlert (conditional)
│   │   ├── StatCard × 4
│   │   ├── SupplyCapUtilization + HealthRatio (gradient-border, 2-col)
│   │   ├── BridgeParameters (3-col grid)
│   │   ├── AttestationHistory (table or empty state)
│   │   ├── HowItWorks × 6 (pipeline)
│   │   └── BLE Explainer Card
│   │
│   ├── PointsPage
│   │   ├── PageHeader
│   │   ├── Season Progress Bar
│   │   ├── Tab Nav (Overview / Leaderboard / Calculator)
│   │   ├── Overview Tab
│   │   │   ├── Your Points (StatCard × 4)
│   │   │   ├── Points Breakdown (per-action)
│   │   │   ├── How It Works (formula card)
│   │   │   ├── 3 Seasons Multiplier Table
│   │   │   ├── What Earns Points (Canton vs Ethereum)
│   │   │   ├── Points APY by TVL Table
│   │   │   ├── Maximize Your Points (4 tips)
│   │   │   └── Airdrop Info Card
│   │   ├── Leaderboard Tab (top-25 table)
│   │   └── Calculator Tab
│   │       ├── Implied APY (StatCard × 3)
│   │       ├── Scenarios Table
│   │       └── Multiplier Schedule
│   │
│   └── AdminPage
│       ├── Section Tab Bar (6 tabs)
│       └── Section Forms (inputs + TxButtons)
│
└── Footer
    ├── Status indicator (green dot)
    ├── Links (Docs · GitHub · Discord)
    └── Copyright
```

---

## Responsive Breakpoints

| Breakpoint | Nav        | StatCards      | Feature Cards   | Action Card  |
|------------|------------|----------------|-----------------|--------------|
| `< sm`     | Mobile menu| 1 column       | 1 column        | Full width   |
| `sm`       | Mobile menu| 2 columns      | 1 column        | Full width   |
| `lg`       | Desktop nav| 4 columns      | 2 columns       | Full width   |

---

## Key Interactions

1. **Wallet Connect** — Click "Connect Wallet" → MetaMask popup → address shown with green dot
2. **Chain Toggle** — Click pill → swaps all pages between Ethereum and Canton variants
3. **Tab Switching** — Click tab → active underline animates, form resets, amount clears
4. **MAX Button** — Fills input with full wallet balance for selected token
5. **Amount Input** — Focus triggers glow border; live preview updates with 300ms debounce
6. **TxButton** — Click → simulate tx → send tx → loading spinner → success alert with Etherscan link / error alert
7. **Approve Flow** — If allowance insufficient, auto-approve before main tx (sequential)
8. **Page Navigation** — `useState("dashboard")` in `index.tsx`, no URL routing (SPA)

---

## File Map

```
frontend/src/
├── pages/
│   ├── index.tsx            — SPA router (useState page switch)
│   ├── _app.tsx             — Next.js app wrapper
│   ├── _document.tsx        — HTML document
│   ├── DashboardPage.tsx    — Protocol + portfolio dashboard
│   ├── MintPage.tsx         — USDC ↔ mUSD mint/redeem
│   ├── StakePage.tsx        — mUSD ↔ smUSD stake/unstake
│   ├── BorrowPage.tsx       — Collateral deposit, borrow, repay, withdraw + leverage looping
│   ├── BridgePage.tsx       — Canton attestation monitoring
│   ├── AdminPage.tsx        — Protocol admin panel
│   ├── PointsPage.tsx       — Points program, seasons, leaderboard, APY calculator
│   ├── LeveragePage.tsx     — (standalone leverage, code now merged into BorrowPage)
│   └── LiquidationsPage.tsx — (unused, not in nav)
│
├── components/
│   ├── Layout.tsx           — Shell: bg, navbar, main, footer
│   ├── Navbar.tsx           — Top nav with 7 items + wallet + chain toggle
│   ├── ChainToggle.tsx      — ETH ⟷ Canton pill switch
│   ├── StatCard.tsx         — Metric card (color, icon, trend, sub, variant)
│   ├── PageHeader.tsx       — Title + subtitle + badge
│   ├── TxButton.tsx         — Transaction button with loading state
│   └── canton/              — Canton-chain page equivalents
│       ├── CantonDashboard.tsx
│       ├── CantonMint.tsx
│       ├── CantonStake.tsx
│       ├── CantonBorrow.tsx
│       ├── CantonBridge.tsx
│       └── CantonAdmin.tsx
│
├── hooks/
│   ├── useWalletConnect.ts  — WalletConnect / MetaMask connection
│   ├── useWCContracts.ts    — Contract instances via WalletConnect signer
│   ├── useContract.ts       — Legacy contract hook
│   ├── useWallet.ts         — Legacy MetaMask hook
│   ├── useTx.ts             — Tx send with simulation, loading/error/success
│   ├── useChain.ts          — Chain state (ethereum / canton toggle)
│   └── useCanton.ts         — Canton/DAML integration
│
├── lib/
│   ├── config.ts            — Contract addresses, decimals, validation
│   └── format.ts            — formatUSD, formatToken, formatBps, formatHealthFactor, shortenAddress, formatTimestamp
│
├── abis/                    — Contract ABI TypeScript exports
│   ├── MUSD.ts, SMUSD.ts, DirectMint.ts, Treasury.ts
│   ├── CollateralVault.ts, BorrowModule.ts, LiquidationEngine.ts
│   ├── BLEBridgeV9.ts, PriceOracle.ts, ERC20.ts
│
└── styles/
    └── globals.css          — Full Tailwind design system (350 lines)
```
