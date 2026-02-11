# Minted Protocol — Designer Handoff

> Complete section-by-section breakdown for designing the mUSD dApp.
> Dark theme only. Single-page application. Two-chain architecture (Ethereum + Canton).

---

## Brand Identity

- **Product Name:** Minted Protocol
- **Tagline:** "The Institutional Ownership Reserve Currency, powered by Canton Network"
- **Hero Headline:** "The currency for the Web3 Ownership Economy"
- **Tokens:** mUSD (stablecoin), smUSD (staked mUSD), $MINT (governance — future TGE)
- **Chains:** Ethereum (primary) and Canton Network (institutional DeFi chain)
- **Tone:** Institutional but approachable. Think Bloomberg Terminal meets modern DeFi — clean, data-dense, trustworthy.

---

## Site Architecture

The app has two layers:

1. **Landing Page** — a cinematic pre-app gate. Full viewport. No scroll. One CTA.
2. **Main App** — entered via "Enter App" button. 6 pages, top navbar, SPA routing.

Within the main app, every page has an **Ethereum variant** and a **Canton variant**. A pill toggle in the navbar switches between them. When Canton is selected, the visual theme should feel distinctly different from Ethereum — this is how users know which chain they're operating on.

---

## Global Shell

### Navbar (sticky, always visible in the main app)

```
┌──────────┬──────────────────────────────────────┬────────────────────┐
│  Logo    │  Mint · Stake · Borrow & Lend ·      │  [ETH ⟷ Canton]   │
│  Minted  │  Bridge · Points                     │  [Connect Wallet]  │
│  Protocol│  (Admin is URL-only, not in nav)      │                    │
└──────────┴──────────────────────────────────────┴────────────────────┘
```

**Elements:**
- **Logo:** Left-aligned. "Minted Protocol" wordmark or logo.
- **Nav Tabs:** Horizontal text links. Active tab has an underline indicator. 5 visible items: Mint, Stake, Borrow & Lend, Bridge, Points.
- **Chain Toggle:** Pill-style toggle between "Ethereum" and "Canton". When toggled, the entire app switches chain context — different page components, different data sources, visually distinct.
- **Connect Wallet:** Button that triggers MetaMask/WalletConnect popup. Once connected, shows truncated address with a connection status indicator.

**Mobile (< lg breakpoint):** Nav tabs collapse into a hamburger menu → slide-down overlay with full-width nav items.

### Footer

```
● All systems operational          Docs · GitHub · Discord          © 2026 Minted
```

- Left: operational status dot + text
- Center/Right: external links
- Far right: copyright

---

## Page 0 — Landing Page

**Purpose:** First impression. Cinematic. Establish credibility and intrigue. One action: "Enter App."

**Layout:** Full viewport, no scroll, no footer.

### Background: THREE.js Animated Scene
- Full-viewport 3D canvas behind all content
- ~2000 particles in a spherical distribution with additive blending
- Central pulsing orb (fresnel shader effect)
- 3 orbiting torus rings at different angles and speeds
- Neural-network-style connection lines between nearby particles
- Mouse-follow camera with smooth lerp
- Dark vignette overlay so text remains legible

### Content Overlay

**Top bar (minimal navbar):**
- Logo left, "Enter App" button right. No other nav items.

**Center (vertically and horizontally):**
- Two-line headline in large gradient text:
  - Line 1: "The currency for the"
  - Line 2: "Web3 Ownership Economy"

**Bottom (above fold):**
- 4 stat cards in a horizontal row:

| Stat | Example Value | Description |
|------|--------------|-------------|
| mUSD Supply | 24.8M | Total circulating mUSD |
| Staking APY | 12.4% | Current smUSD staking yield |
| Active Users | 3,847 | Protocol participants |
| Canton Attestation Value | 18.2M | Total value attested on Canton |

**Nothing else.** No feature sections, no scroll content, no secondary CTAs. Pure cinema + one button.

**Interaction:** "Enter App" → transitions to the Dashboard/Mint page.

---

## Page 1 — Dashboard / Mint (`/dashboard`)

**Purpose:** The home base. Users see their portfolio at a glance and can immediately mint or redeem mUSD. Dashboard and Mint are merged into one page — the data panels provide context while the mint widget provides action.

**Subtitle:** "Mint mUSD, track your portfolio, and monitor protocol health"

### Top: 4 Stat Cards (horizontal row)

| Metric | Data |
|--------|------|
| Your Balance | User's mUSD balance |
| Your Staked Earnings | smUSD yield earned to date |
| Current APY | smUSD staking yield % |
| mUSD Supply | Current supply as % of cap |

### Main: 2-Column Layout

**Left column (narrower, ~40%):** Mint/Redeem Widget
- Card with a prominent border treatment
- **Tab toggle:** Mint | Redeem
- **Collateral dropdown** (Mint mode): USDC, USDT, DAI
- **Amount input** with MAX button and token badge
- **Arrow separator** (↓)
- **Output preview** showing how much mUSD you'll receive
- **Fee info line** (rate in bps)
- **Primary action button:** "Mint mUSD" or "Redeem mUSD"
- **Success/Error alert** below the button (with Etherscan link on success)
- **2 mini stat cards** below widget:
  - Remaining Mintable (how much supply cap is left)
  - Available to Redeem (user's redeemable balance)

**Right column (wider, ~60%):** Data Panels

1. **Supply Growth Chart**
   - SVG area chart showing mUSD supply over time
   - Time range selector pills: 1w · 1m · 3m · 6m · 1y
   - Start/end date labels
   - Current supply value displayed

2. **Recent Activity Table**
   - Columns: Type | Amount | Block
   - Mint/Redeem action badges
   - Links to block explorer

3. **3 Protocol Health Stat Cards** (horizontal row)
   - Total Backing ($)
   - smUSD Staked ($)
   - Supply Cap Utilization (%)

### Bottom: Explainer Card

> "Mint mUSD 1:1 against selected collateral, validated in real time by attestations on the Canton Network, then stake to begin earning."

### Canton Variant Differences
- Collateral dropdown replaced by a DAML contract selector
- Stat cards show Canton-native contract counts and totals
- Adds a **Protocol Services status grid** showing live status of: DirectMint, Staking, Oracle, Issuer, Pool
- Mint/Redeem actions go through Canton DAML template exercise instead of Ethereum contract calls

---

## Page 2 — Stake (`/stake`)

**Purpose:** Stake mUSD to receive smUSD and earn yield. Simple, focused page. On Canton, adds a second staking widget for Canton Coin (Boost Pool).

**Max width:** Narrower than other pages (~max-w-3xl) — this is a single-action page.

### Top: 2 Stat Cards

| Metric | Data |
|--------|------|
| Total Staked | Total mUSD in the staking vault |
| Current APY | Staking yield % |

### Main: Stake/Unstake Widget
- Card with prominent border treatment
- **Tab toggle:** ➕ Stake mUSD | 🔄 Unstake smUSD
- **2 balance cards inside the widget:**
  - Your mUSD Balance
  - Your smUSD Balance (with sub-text showing mUSD equivalent: "≈ X.XX mUSD")
- **Amount input** with MAX button and token badge (mUSD or smUSD depending on tab)
- **Arrow separator** (↓)
- **Output preview** (shows what you'll receive)
- **Exchange info** (current rate, cooldown period, fee = none)
- **Primary action button:** "Stake mUSD" or "Unstake smUSD"
- **Success/Error alert** with Etherscan link

### Cooldown Timer (conditional — only shows if user has an active cooldown)
- Card showing:
  - "⏱ Withdrawal Cooldown" heading
  - "X.X days remaining" (10-day cooldown period)
  - Progress bar with "XX% Complete" badge
  - Tokens continue earning yield during cooldown

### Explainer Card: AI Yield Aggregation Engine

> "Staking distributes generated yield exclusively to mUSD stakers, using our AI yield aggregation engine. The AI deliberates across hundreds of protocols in Web3 using a proprietary algorithm, taking into consideration many different variables: Highest Yield, Pool Liquidity, Weighted Performance Over Time, Security/Risk Profile, Oracle Stability, Curators, and more."

### Info Card: Unstaking

> "When you unstake, you'll receive your mUSD back plus any accrued yield. There is a 10-day cooldown period to process unstaking requests. Your tokens continue to earn yield during the cooldown period."

### Canton Variant Differences
- **3rd Stat Card:** Minted Points Earned
- Uses DAML contract selector instead of Ethereum contract calls
- **Canton Coin Staking Widget (Canton-only, appears below main widget):**

  **Heading:** "Stake Canton Coin (Boost Pool)"

  **Explainer text:**
  > "Stake 20% of your mUSD stake in Canton Coin to receive a boosted yield of 2-4% PLUS 60% of all validator rewards PLUS a 10x Minted Points boost"

  **3 stat cards inside widget:**
  - Boost Pool APY (2-4%)
  - Validator Rewards (60% share)
  - Points Multiplier (10×)

  **Tabs:** Stake Canton Coin | Unstake Canton Coin
  **Amount input** for Canton Coin
  **Button:** "Stake Canton Coin (Coming Soon)" — disabled state

---

## Page 3 — Borrow & Lend (`/borrow`)

**Purpose:** Multi-function lending page. Users deposit collateral, borrow mUSD against it, repay, withdraw, or open automated leverage loop positions. The interest paid by borrowers goes to mUSD stakers.

**Subtitle:** "mUSD stakers earn the interest"
**Max width:** ~max-w-4xl

### Collateral Reference Table
A card showing supported collateral with key parameters:

**Ethereum:**

| Asset | Max LTV | Liquidation Threshold |
|-------|---------|----------------------|
| ETH | 75% | 80% |
| WBTC | 75% | 80% |
| smUSD | 90% | 93% |

**Canton:**

| Asset | Max LTV | Liquidation Threshold |
|-------|---------|----------------------|
| Canton Coin | 65% | 75% |
| smUSD | 90% | 93% |

### Health Factor & Position Summary (conditional — only if user has debt > 0)
- Card showing:
  - **Health Factor:** large number (e.g. 2.45) with status text (Healthy / At Risk / Liquidatable)
  - Gauge/progress bar visualizing the health factor
  - Summary line: Collateral: $XX · Debt: $XX · Utilization: XX%
  - "Close Position" button

### Action Card (5-tab widget)
Card with prominent border treatment. 5 tabs:

**Tab 1-4: ➕ Deposit | 💰 Borrow | 🔄 Repay | ⬆ Withdraw**
- Collateral selector dropdown (for Deposit and Withdraw tabs) showing each asset with its LTV and liquidation threshold
- Amount input with MAX button
- Primary action button
- Success/Error alert

**Tab 5: ⚡ Loop**
This is the leverage looping feature — the protocol's signature mechanic.

- **Leverage Drag Slider:**
  - Visual slider from 2x to 5x
  - Large display of selected multiplier (e.g. "3x")
  - Tick marks at 2x, 3x, 4x, 5x
- **Collateral Amount input**
- **Position Preview** (calculated live):
  - Total Collateral after loops
  - Estimated Debt
  - Number of Loop Iterations
  - Effective Leverage
- **"⚡ Open Xx Loop Position"** button

- **Active Leverage Position** (if exists):
  - Shows: Deposited · Total Collateral · Outstanding Debt · Current Leverage
  - "Close Position & Repay Debt" button (danger/destructive styling)

### How Borrowing Works — 5 Step Cards
Horizontal row of numbered steps:
① Choose Collateral → ② Deposit → ③ Borrow → ④ Repay → ⑤ Stakers Earn

### Loop Explainer Card

> "Multiply your sMUSD yield in one click. Deposit your collateral → automatically borrow mUSD, stake it to sMUSD, redeposit, and repeat up to your target leverage. No DEX swaps, no manual steps. Your collateral earns leveraged sMUSD staking yield (6-14% base × your loop multiplier), while your borrow cost is offset by the yield itself. Choose 2x–5x and let the vault handle the rest."

### Looping Strategies — 2 Strategy Cards (side by side)

**sMUSD Maxi (Low-Medium Risk):**
> Multiply your stablecoin yield. One click. Deposit USDCx → DirectMint mUSD, stake it to sMUSD, borrow against it, and re-stake — automatically.

| Loops | Your Deposit | You Earn On | Protocol APY | Points APY* | Total APY |
|-------|-------------|-------------|--------------|-------------|-----------|
| 1× | $10,000 | $10,000 | 6-14% | +28% | 34-42% |
| 2× | $10,000 | $19,000 | 9-22% | +68% | 77-90% |
| 3× | $10,000 | $27,100 | 11-30% | +104% | 115-134% |
| 4× | $10,000 | $34,390 | 14-38% | +136% | 150-174% |

**Canton Maxi (Medium Risk):**
> Stack every yield source in the protocol. All Canton-native. No bridging required. Deposit USDCX → DirectMint mUSD → stake, loop, and deposit CTN into the Boost Pool. You earn staking yield, borrowing points, and validator rewards, all at once.

| Loops | Your Deposit | You Earn On | Protocol APY | Points APY* | Total APY |
|-------|-------------|-------------|--------------|-------------|-----------|
| 1× | $10,000 | $10,000 | 6-14% | +28% | 34-42% |
| 2× | $10,000 | $19,000 | 9-22% | +68% | 77-90% |
| 3× | $10,000 | $27,100 | 11-30% | +104% | 115-134% |
| 4× | $10,000 | $34,390 | 14-38% | +136% | 150-174% |
| 4× + Boost Pool | $10,000 | $34,390 + $8.6k CTN | 14-38% | +197% | 211-235% |

### Canton Variant Differences
- Canton-specific collateral table (Canton Coin + smUSD instead of ETH/WBTC/smUSD)
- DAML Vault CDP list with contract selection
- Vault actions via DAML exerciseChoice
- ⚡ Loop tab shows as "Coming Soon" on Canton

---

## Page 4 — Bridge (`/bridge`)

**Purpose:** Monitoring and transparency page for the Beneficiary Locked Environment (BLE) cross-chain bridge between Ethereum and Canton. This is primarily a read-only dashboard showing bridge health, attestation history, and system parameters. The bridge widget for actual transfers is referenced but the primary UX is observability.

**Reference design:** Look at deBridge or Stargate for UX inspiration.

### Top: Page Header
- Title: "Canton Bridge"
- Dynamic badge: "Active" or "PAUSED"
- If paused: prominent warning alert at the top of the page

### 4 Stat Cards

| Metric | Description |
|--------|-------------|
| Attested Canton Assets | Total value verified on Canton (🏢 icon) |
| Current Supply Cap | Max mintable through bridge (📊 icon) |
| Remaining Mintable | How much more can be minted (💰 icon) |
| Last Attestation | Time since last attestation + timestamp (⏱ icon) |

### Supply Cap & Health Ratio (2-column grid)

**Supply Cap Utilization Card:**
- "XX.X% of capacity used"
- Progress bar
- "Minted: $XX" and "Available: $XX" below

**Bridge Health Ratio Card:**
- Large number display (e.g. "1.85")
- Status text: "Healthy"
- Gauge visualization with scale: 1.0 — 1.5 — 2.0+

### Bridge Parameters (3-column grid)

| Collateral Ratio | Required Signatures | Current Nonce |
|-----------------|-------------------|--------------|
| 150% | 3 | 42 |
| Overcollateralized | Multi-sig threshold | Sequence number |

### Attestation History Table
- Columns: Block # | Attestation Hash | Canton Assets | New Cap | Nonce
- Truncated hashes with copy button
- Empty state: clipboard icon + "No attestations yet"

### How the Bridge Works — 6 Step Pipeline
Horizontal row (3×2 grid on mobile):
① Observe → ② Verify → ③ Sign → ④ Aggregate → ⑤ Update → ⑥ Mint

Each step gets a numbered circle indicator.

### BLE Explainer Card

> "Move mUSD and sMUSD between Ethereum and Canton. Your yield never stops. Powered by Minted's proprietary BLE (Beneficiary Locked Environment) — a multi-sig attestation system where institutional validators verify every cross-chain transfer. No relayers, no optimistic windows. Every bridge action is cryptographically attested, validating assets on Canton, supply-cap enforced, and settled with finality on both chains."

---

## Page 5 — Points (`/points`)

**Purpose:** Gamification and incentive layer. Users track their points earnings, see the leaderboard, and use a calculator to project their airdrop value. Points convert to $MINT tokens at TGE.

**Header subtitle:** "Earn points for using the protocol. Points convert to $MINT token airdrop."
**Badge:** Current season name

### Season Progress Bar
- Card showing:
  - "Season 1 — Genesis"
  - "2x multiplier · 45 days remaining"
  - Progress bar with "58% Complete" label
  - Season dots: ● Season 1 (active) · ○ Season 2 · ○ Season 3

### 3-Tab Navigation: Overview | Leaderboard | Calculator

---

### Overview Tab

**Your Points — 4 Stat Cards:**

| Metric | Description |
|--------|-------------|
| Total Points | Lifetime accumulated points |
| Global Rank | User's rank among all participants |
| Current Season | Points earned this season |
| Seasons Active | How many seasons the user has participated in |

**Points Breakdown Card:**
Per-action breakdown by season (table or itemized list)

**How It Works Card:**
> "Your Points = USD Value × Multiplier × Hours"

**3 Seasons Multiplier Table:**

| Season | Boost Pool | sMUSD | Collateral | Borrow |
|--------|-----------|-------|------------|--------|
| 1 — Genesis | 10× 🔥 | 4× | 3× | 2× |
| 2 — Growth | 6× | 2.5× | 2× | 1.5× |
| 3 — Maturity | 4× | 1.5× | 1× | 1× |

> Multipliers are exponential for Canton Native participants.

**What Earns Points (2-column grid):**

**Canton (higher multipliers):**
- Stake mUSD → sMUSD
- Stake Canton Coin
- Deposit sMUSD or Canton Coin as collateral
- Borrow mUSD
- Open Leverage Vault positions
- Deposit $CC in the Canton Boost Pool ← **highest multiplier, always** (highlight this visually)

**Ethereum:**
- Stake mUSD → sMUSD
- Deposit ETH, WBTC, or sMUSD as collateral
- Borrow mUSD
- Open Leverage Vault positions

**Points APY by TVL Table:**

> Your points APY depends on total protocol TVL. The fewer people depositing, the bigger your share. Get in early, earn BIG.

| Weighted TVL | Canton Boost Pool 🔥 | sMUSD (Canton) | sMUSD (Ethereum) |
|-------------|---------------------|----------------|-----------------|
| $5M | 354% | 142% | 106% |
| $10M | 177% | 71% | 53% |
| $25M | 71% | 28% | 21% |
| $50M | 35% | 14% | 11% |

**Maximize Your Points — 4 Tips:**
1. **Get in early** — Season 1 multipliers are the highest
2. **Use Canton** — every action earns the most points
3. **Loop your sMUSD** — leverage multiplies your points on every layer
4. **Deposit $CC in the Boost Pool** — 10× in Season 1, always the highest multiplier

**Example Scenario (callout card):**
> $10k capital, 4 loops, Season 1. Positions: $34.4k sMUSD collateral, $24.4k debt, $8.6k Canton Boost Pool.

| | $10M TVL | $25M TVL | $50M TVL | $100M TVL |
|---|---------|---------|---------|----------|
| Protocol yield | 22.2% | 22.2% | 22.2% | 22.2% |
| Points — sMUSD collateral | 488% | 244% | 98% | 49% |
| Points — Borrow | 194% | 97% | 39% | 19% |
| Points — Boost Pool | 305% | 152% | 61% | 31% |
| | compounds | compounds | compounds | compounds |
| **Points APY (on $10k)** | **987%** | **493%** | **197%** | **99%** |

**Airdrop Info Card:**
> Distribution: End of Season 3, proportional to your share of total points. Points → $MINT Tokens at TGE.

---

### Leaderboard Tab
- Top 25 table
- Columns: Rank · Address (truncated) · Total Points
- User's own row highlighted/distinguished if they're on the board

---

### Calculator Tab
- **3 Stat Cards:** Implied APY · Token Price · Total Airdrop Value
- **Scenarios Table:** deposit amount · estimated points · allocation % · dollar value · APY
- **Multiplier Schedule:** per-action cards showing multipliers with ETH/CTN chain badges

---

## Page 6 — Admin (`/admin`)

**Purpose:** Internal operations console. Not user-facing. Wallet-gated to admin role holders only. Dense, functional, no beautification.

**Access:** Direct URL only (`/admin`). **Not in the navigation.** If the connected wallet doesn't hold `DEFAULT_ADMIN_ROLE` on the core contracts → 404.

**Design philosophy:**
- Dark theme, dense layout — think Grafana, not Dribbble
- Collapsible accordion sections (all default open, state persisted to localStorage)
- Every write action requires a confirmation modal showing exact call data
- Transaction status: pending spinner → success checkmark → error with decoded revert reason
- Role indicator at top: show which roles the connected wallet holds; grey out actions the wallet can't execute

### Section 1: Protocol Health Dashboard (read-only, top of page)
Live data polled every 15 seconds. "At a glance" panel.

| Metric | Source |
|--------|--------|
| mUSD Total Supply | MUSD.totalSupply() |
| mUSD Supply Cap | MUSD.supplyCap() |
| Supply Cap Utilization | supply / cap × 100 (% bar, warning when >90%) |
| sMUSD Total Assets | SMUSD.totalAssets() |
| sMUSD Share Price | SMUSD.convertToAssets(1e18) |
| Treasury Total Value | TreasuryV2.totalValue() |
| Treasury Net Value | TreasuryV2.totalValueNet() |
| Treasury Accrued Fees | TreasuryV2.accruedFees() |
| Total Borrows | BorrowModule.totalBorrows() |
| Protocol Reserves | BorrowModule.protocolReserves() |
| Morpho Health Factor | MorphoLoopStrategy.getHealthFactor() |
| Morpho Leverage | MorphoLoopStrategy.getCurrentLeverage() |
| Pendle PT Balance | PendleStrategyV2.totalValue() |
| All contracts paused() | Status dots per contract |
| Oracle feed health | Per-token feed status |
| Price per asset | ETH, WBTC, sMUSD prices |
| Circuit breaker status | On/off indicator |
| Failed mints count | Pending retry count |

### Section 2: Emergency Controls
Visually distinct section — warning styling, double-confirmation required (typed "CONFIRM" input in modal).

| Action | Contract Call | Role |
|--------|-------------|------|
| Pause All | .pause() on all 10 contracts | PAUSER / GUARDIAN |
| Unpause All | .unpause() on all 10 contracts | DEFAULT_ADMIN |
| Emergency Withdraw Treasury | TreasuryV2.emergencyWithdrawAll() | GUARDIAN |
| Emergency Deleverage Morpho | MorphoLoopStrategy.emergencyDeleverage() | GUARDIAN |
| Emergency Withdraw Pendle | PendleStrategyV2.emergencyWithdraw() | GUARDIAN |
| Emergency Reduce Bridge Cap | BLEBridgeV9.emergencyReduceCap(newCap, reason) | EMERGENCY |
| Force Update Bridge Nonce | BLEBridgeV9.forceUpdateNonce(newNonce, reason) | EMERGENCY |
| Emergency Close Leverage Position | LeverageVault.emergencyClosePosition(user) | DEFAULT_ADMIN |
| Emergency Withdraw (per contract) | DepositRouter/LeverageVault/TreasuryReceiver | DEFAULT_ADMIN |

### Section 3: Fee Management

| Action | Inputs |
|--------|--------|
| Set Mint/Redeem Fees | Two number inputs (max 1000 bps each) |
| Set Fee Recipient | Address input |
| Withdraw Mint Fees | Button (show pending amount) |
| Withdraw Redeem Fees | Button (show pending amount) |
| Set Router Fee | Number input (bps) |
| Withdraw Router Fees | Address + button |
| Claim Treasury Fees | Button (show accrued amount) |
| Withdraw Protocol Reserves | Address + amount |
| Set Interest Rate | Number input (bps) |

### Section 4: Oracle & Price Management

| Action | Inputs |
|--------|--------|
| Set/Update Price Feed | Token, feed address, stale period, decimals |
| Remove Price Feed | Token dropdown |
| Update Price (after circuit breaker) | Token dropdown |
| Reset Last Known Price | Token dropdown |
| Set Max Deviation | Slider (100-5000 bps) |
| Toggle Circuit Breaker | Toggle switch |
| Set sMUSD Price Bounds | Min + Max inputs |
| Increment Round | Button |

### Section 5: Strategy Management

| Action | Inputs |
|--------|--------|
| Rebalance Treasury | Button (show current allocations first) |
| Set Reserve BPS | Number input |
| Set Min Auto Allocate | Number input |
| Remove Strategy | Address dropdown |
| Morpho — Set Safety Buffer | Number input (bps) |
| Morpho — Set Active | Toggle |
| Pendle — Set Slippage | Number input (bps) |
| Pendle — Set PT Discount | Number input (bps) |
| Pendle — Set Rollover Threshold | Number input (seconds) |
| Pendle — Roll to New Market | Button |
| Pendle — Trigger Rollover | Button |
| Pendle — Set Active | Toggle |
| Pendle — Set Market Selector | Address input |
| Whitelist Pendle Market | Address + category string |
| Remove Pendle Market | Address dropdown |

### Section 6: Bridge & Cross-Chain

| Action | Inputs |
|--------|--------|
| Authorize Router | Chain ID + bytes32 router address |
| Revoke Router | Chain ID dropdown |
| Retry Failed Mint | Select from failed list |
| Set Direct Mint | Address input |
| Set mUSD Token (bridge) | Address input |
| Set Min Signatures | Number input |
| Set Daily Cap Increase | Number input |
| Set Collateral Ratio | Number input (bps) |
| Request Upgrade (Treasury) | Address input |
| Cancel Upgrade (Treasury) | Button |
| Mark Deposit Complete | Number input (sequence) |
| Sync Canton Shares | Two number inputs (shares, epoch) |
| Set Blacklist (MUSD) | Address + toggle |

### What does NOT go on Admin
- User management / role granting → done via Gnosis Safe/multisig
- Contract deployments or upgrades → done via deploy scripts
- Anything end-user-facing → belongs on the main dApp

---

## Shared Component Library

These components appear across multiple pages and should be designed as a reusable system:

| Component | Used On | Notes |
|-----------|---------|-------|
| **StatCard** | Every page | Metric card with icon, value, label, optional sub-text and trend indicator. Has variants for different emphasis levels. |
| **PageHeader** | Every page | Title + optional subtitle + optional badge (chain name, status) |
| **Action Card** | Mint, Stake, Borrow | Card with prominent border. Contains tabs, inputs, buttons, alerts. The primary interactive widget on each page. |
| **AmountInput** | Mint, Stake, Borrow | Numeric input with MAX button and token badge |
| **TxButton** | Mint, Stake, Borrow, Admin | Primary action button. States: default → loading spinner → success → error |
| **AlertStatus** | Mint, Stake, Borrow | Success/error feedback bar with optional Etherscan link |
| **CollateralSelector** | Mint, Borrow | Dropdown showing asset name, LTV, and liquidation threshold |
| **ChainToggle** | Navbar (global) | Pill toggle: Ethereum ⟷ Canton |
| **CooldownTimer** | Stake | Progress bar with time remaining |
| **Table** | Borrow, Bridge, Points, Admin | Data table with consistent row styling |

---

## Responsive Behavior

| Breakpoint | Nav | Stat Cards | Feature Cards | Action Card |
|------------|-----|-----------|--------------|-------------|
| Mobile (< sm) | Hamburger menu | 1 column | 1 column | Full width |
| Tablet (sm) | Hamburger menu | 2 columns | 1 column | Full width |
| Desktop (lg+) | Horizontal nav | 4 columns | 2 columns | Full width |

---

## Key Interactions

| # | Interaction | Behavior |
|---|------------|----------|
| 1 | **Connect Wallet** | Click → MetaMask/WalletConnect popup → address shown with status indicator |
| 2 | **Chain Toggle** | Click pill → entire app swaps between Ethereum and Canton variants |
| 3 | **Tab Switching** | Click tab → active underline animates, form resets, amount clears |
| 4 | **MAX Button** | Fills input with user's full wallet balance for selected token |
| 5 | **Amount Input** | Focus triggers border highlight; live output preview updates with 300ms debounce |
| 6 | **TxButton** | Click → simulate tx → send tx → loading spinner → success alert with explorer link / error alert |
| 7 | **Approve Flow** | If ERC-20 allowance insufficient, auto-approve step before main tx (sequential) |
| 8 | **Leverage Slider** | Drag 2x–5x → live position preview recalculates |

---

## Design Principles

1. **Dark theme only** — no light mode toggle
2. **Data-forward** — stat cards, tables, and charts should be prominent. Users are here for numbers.
3. **Ethereum vs Canton must feel distinct** — when user toggles chains, the visual identity should shift noticeably so they always know which chain they're on
4. **Institutional trust** — clean typography, precise alignment, restrained animation. Not playful/meme. This is institutional DeFi.
5. **Action widgets are the hero** — the mint/stake/borrow cards are the most important UI elements per page. They should be visually elevated.
6. **Explainer cards are secondary** — educational content sits below the fold. Present but not dominant.
7. **Mobile-first responsive** — everything must work on mobile. Widgets go full-width, stat cards stack vertically.
