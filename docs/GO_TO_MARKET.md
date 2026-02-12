# Minted mUSD — Go-To-Market Strategy

> **Version**: 1.0  
> **Date**: February 12, 2026  
> **Status**: Pre-Deposit Phase  
> **Target**: $100M TVL within 6 months of mainnet launch

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Market Opportunity](#2-market-opportunity)
3. [Product Positioning](#3-product-positioning)
4. [Competitive Landscape](#4-competitive-landscape)
5. [Growth Phases](#5-growth-phases)
6. [Points & Seasons Program](#6-points--seasons-program)
7. [Referral System](#7-referral-system)
8. [KOL & Influencer Strategy](#8-kol--influencer-strategy)
9. [Merkl & Points Platform Integration](#9-merkl--points-platform-integration)
10. [Dune Dashboard & Transparency](#10-dune-dashboard--transparency)
11. [Public API & Aggregator Access](#11-public-api--aggregator-access)
12. [Revenue Model](#12-revenue-model)
13. [Launch Checklist](#13-launch-checklist)
14. [Risk Factors](#14-risk-factors)

---

## 1. Executive Summary

Minted mUSD is a yield-bearing stablecoin built on a dual-chain architecture (Ethereum + Canton Network). Users mint mUSD by depositing USDC/USDT, earn yield through RWA-backed treasury strategies, and benefit from Canton's privacy-preserving settlement layer.

**Core value proposition**: Institutional-grade yield on stablecoins with on-chain verifiability and Canton's sub-second settlement.

**GTM thesis**: Replicate the pre-deposit → points → airdrop playbook pioneered by Ethena ($0 → $2.5B TVL) and Blast ($2.3B pre-launch TVL), adapted for the RWA/stablecoin vertical.

---

## 2. Market Opportunity

### Total Addressable Market

| Metric | Value | Source |
|--------|-------|--------|
| Stablecoin market cap | $180B+ | DefiLlama, Feb 2026 |
| Yield-bearing stablecoin segment | $15B+ | sDAI, sUSDe, sfrxETH |
| RWA tokenized assets | $12B+ | RWA.xyz |
| Annual stablecoin transfer volume | $12T+ | Visa on-chain report |

### Why Now

1. **Regulatory clarity** — MiCA in EU, US stablecoin legislation progressing
2. **RWA momentum** — BlackRock BUIDL, Ondo, Centrifuge proving institutional demand
3. **Canton launch** — First privacy-preserving DLT with major financial institution backing (Digital Asset)
4. **Yield compression in DeFi** — Users moving from volatile DeFi yields to stable RWA-backed returns

---

## 3. Product Positioning

### One-liner
> "The yield-bearing stablecoin settled on Canton — institutional yield, DeFi composability."

### Positioning Matrix

| Dimension | Minted mUSD | USDC/USDT | DAI/sDAI | USDe (Ethena) | FRAX |
|-----------|-------------|-----------|----------|---------------|------|
| Yield | ✅ RWA-backed | ❌ None | ✅ DSR | ✅ Basis trade | ✅ AMO |
| Settlement | ✅ Canton (sub-second, private) | Ethereum only | Ethereum only | Ethereum only | Ethereum only |
| Collateral transparency | ✅ Merkle-verified snapshots | Attestations only | On-chain | Custodian reports | On-chain |
| Bridge | ✅ Canton ↔ ETH | N/A | N/A | N/A | Fraxferry |
| Borrowing | ✅ Native BorrowModule | External (Aave/Compound) | External | External | Fraxlend |

### Key Differentiators

1. **Dual-chain settlement** — Canton for institutional flows, Ethereum for DeFi composability
2. **Integrated lending** — Native BorrowModule with interest rate model, no external protocol dependency
3. **Verifiable transparency** — Daily Merkle-rooted point snapshots, public CSV exports, Dune dashboard
4. **Yield from real assets** — Treasury strategies backed by T-bills/RWA, not basis trade risk

---

## 4. Competitive Landscape

### Comparable Protocol Trajectories

| Protocol | Launch Strategy | Time to $1B TVL | Key Tactic |
|----------|----------------|-----------------|------------|
| **Ethena (USDe)** | Shard Campaign (points) → airdrop | 3 months | 20× shard boost for early depositors |
| **Blast** | Pre-deposit with native yield | Pre-launch ($2.3B before mainnet) | ETH yield + Blast Points |
| **EtherFi** | Loyalty points → $ETHFI airdrop | 4 months | Restaking narrative + points |
| **Usual (USD0)** | Pills program (points) | 5 months | RWA yield + governance rights |
| **Sky (formerly Maker)** | DSR rate hike (5% → 8%) | Already at $8B | Rate arbitrage drove DAI demand |

### Lessons Learned

- **Ethena**: Shards with multipliers created FOMO. 20× early-bird bonus drove first $500M in 6 weeks.
- **Blast**: Pre-deposit with locked capital + points. Risk: users felt locked. Minted should keep mUSD liquid.
- **EtherFi**: Referral codes were a growth hack — each whale brought 5-10 followers.
- **Usual**: RWA-backed yield positioned as "safer than USDe." Same positioning works for mUSD.
- **Key takeaway**: Points alone aren't enough. You need (1) real yield, (2) referral virality, (3) KOL amplification, and (4) transparent dashboards for CT content.

---

## 5. Growth Phases

### Phase 1: Pre-Deposit (Weeks 1-4)

**Goal**: Build waitlist, establish CT presence, seed early community.

| Action | Owner | Timeline | KPI |
|--------|-------|----------|-----|
| Launch landing page with deposit countdown | Frontend | Week 1 | 10K waitlist signups |
| Deploy points API (`/api/points`) | Backend | Week 1 | API uptime >99% |
| KOL outreach (Tier 1 — 5 KOLs) | BD | Weeks 1-2 | 3 confirmed partnerships |
| Galxe quest campaign (follow + join Discord) | Marketing | Week 2 | 5K quest completions |
| Dune dashboard live with testnet data | Data | Week 2 | Public dashboard URL |
| Audit report published | Security | Week 3 | Report on GitHub |
| Referral system live (early access codes) | Backend | Week 3 | 500 codes generated |

### Phase 2: Genesis Deposit (Months 1-3) — Season 1

**Goal**: $25M TVL, 2,000 unique depositors.

| Action | Owner | Timeline | KPI |
|--------|-------|----------|-----|
| Mainnet launch with 10× point boost | Protocol | Month 1 | $5M TVL in first week |
| KOL threads with Dune screenshots | Marketing | Month 1 | 50K impressions/thread |
| Merkl campaign for mUSD/USDC Curve pool | DeFi | Month 1 | $5M LP TVL |
| Layer3 on-chain quests (mint 100+ mUSD) | Growth | Month 2 | 1,000 quest completions |
| Referral leaderboard on frontend | Frontend | Month 2 | Top referrer brings 50+ users |
| First transparency snapshot with Merkle root | Data | Month 1 | Root published on-chain |
| Bankless or Unchained podcast appearance | BD | Month 2-3 | 100K+ listens |

### Phase 3: Growth (Months 4-6) — Season 2

**Goal**: $100M TVL, 10,000 unique holders, exchange listings.

| Action | Owner | Timeline | KPI |
|--------|-------|----------|-----|
| Reduce point boost to 6× (scarcity) | Protocol | Month 4 | Retention >80% |
| CEX integration (Binance/Coinbase custody) | BD | Month 4-5 | 1 CEX listing |
| Governance token announcement ($MNTD) | Tokenomics | Month 5 | 50K social impressions |
| Snapshot for airdrop eligibility cutoff | Data | Month 5 | Clear criteria published |
| Strategic DeFi integrations (Aave, Morpho) | DeFi | Month 5-6 | mUSD as collateral |
| Canton institutional pilot (1-2 banks) | BD | Month 6 | LOI signed |

### Phase 4: Maturity (Months 7-12) — Season 3

**Goal**: $500M TVL, sustainable revenue, reduced dependency on points.

| Action | Owner | Timeline | KPI |
|--------|-------|----------|-----|
| Token Generation Event (TGE) | Tokenomics | Month 7 | FDV target $200M-$500M |
| Airdrop distribution (15% of supply to points holders) | Smart Contracts | Month 7 | <48h claim window |
| Point boost reduced to 4× → 1× | Protocol | Month 8+ | Organic demand sustains TVL |
| Revenue-sharing to $MNTD stakers | Protocol | Month 9 | Real yield narrative |
| Cross-chain expansion (Arbitrum, Base) | Engineering | Month 10 | Multi-chain mUSD |

---

## 6. Points & Seasons Program

### Point Earning Rates

| Action | Points | Multiplier |
|--------|--------|------------|
| Hold mUSD | 1 pt / mUSD / day | — |
| Stake smUSD (ERC-4626) | 3 pt / smUSD / day | 3× vs holding |
| Mint mUSD | 10 pt / $1 minted | One-time |
| Deposit collateral | 5 pt / $1 deposited | One-time |
| Bridge to Canton | 1.5× on all Canton actions | Ongoing |
| Referral kickback | 10% of referee's points | Ongoing |

### Tier Multipliers

| Tier | Threshold | Multiplier |
|------|-----------|------------|
| 🥉 Bronze | 0 points | 1.0× |
| 🥈 Silver | 10,000 points | 1.25× |
| 🥇 Gold | 100,000 points | 1.5× |
| 💎 Platinum | 1,000,000 points | 2.0× |

### Season Schedule

| Season | Dates | Boost | Purpose |
|--------|-------|-------|---------|
| S1 — Genesis | Mar 1 – Jun 1, 2026 | 10× | Max incentive for early depositors |
| S2 — Growth | Jun 1 – Sep 1, 2026 | 6× | Sustain growth, attract larger capital |
| S3 — Maturity | Sep 1 – Dec 1, 2026 | 4× | Transition to organic demand + TGE |

### Airdrop Assumptions (for APY calculator)

| Parameter | Value |
|-----------|-------|
| Token price assumption | $0.50 |
| Airdrop allocation | 15% of total supply |
| Total token supply | 1,000,000,000 MNTD |
| Implied airdrop value | $75,000,000 |

---

## 7. Referral System

### Architecture

Built and live at commit `d1794b6`. Source: [`points/src/referral.ts`](../points/src/referral.ts).

### Mechanics

- **Code format**: `MNTD-XXXXXX` (6-char alphanumeric, no ambiguous characters O/0/1/I)
- **Kickback**: 10% of referee's earned points minted fresh to referrer (not deducted)
- **Multi-depth**: Grandparent gets 5% (depth decay = 0.5×). Max depth = 2.
- **Limits**: Max 5 codes per user. Unlimited referees per code.
- **Anti-abuse**: Cycle detection, self-referral prevention, per-code usage caps.
- **Viral tracking**: Viral coefficient metric (`total_referrals / total_users`). Target: 1.3.

### KOL Referral Codes

Issue special KOL codes with boosted kickback:

| Tier | Kickback | Who |
|------|----------|-----|
| Standard user | 10% | All users |
| Silver KOL | 12% | Micro-influencers (5K-50K followers) |
| Gold KOL | 14% | Mid-tier KOLs (50K-200K followers) |
| Platinum KOL | 16% | Tier 1 KOLs (200K+ followers) |

### API Endpoints

```
POST /api/referral/create       → Create a referral code (body: {address})
POST /api/referral/link         → Link referee to code (body: {referee, code})
GET  /api/referral/validate/:code → Validate code without linking
GET  /api/referral/stats/:address → User's referral stats
GET  /api/referral/tree/:address  → User's referral tree
GET  /api/referral/metrics       → Global viral coefficient metrics
```

---

## 8. KOL & Influencer Strategy

### Tier 1 — DeFi Yield Specialists (100K–1M+ followers)

These KOLs move TVL. A single thread from them has driven $50M-$100M+ into protocols.

| KOL | Handle | Niche | Why |
|-----|--------|-------|-----|
| Ignas | @DefiIgnas | Points/airdrop meta | Covered Ethena, EtherFi, Usual early. A thread drove $80M+ into Ethena Shard Campaign. |
| Maple Leaf Cap | @Mapleleafcap | RWA/stablecoin | RWA specialist. First to call Maker's RWA pivot. Perfect for mUSD positioning. |
| Dynamo Patrick | @Dynamo_Patrick | Stablecoin infrastructure | Deep technical threads on stablecoin design get massive engagement. |
| Sassal | @sassal0x | Ethereum ecosystem | The Daily Gwei podcast. Trusted voice, large reach. |
| Bankless | @BanklessHQ | DeFi media | A Bankless podcast episode is worth 100 threads. Top-tier distribution. |
| Ryan Sean Adams | @RyanSAdams | DeFi/ETH narrative | Bankless co-host. One RT signals ecosystem legitimacy. |

### Tier 2 — Points-Meta & Airdrop Specialists (50K–300K)

These KOLs drive deposit volume from airdrop farmers — the first wave of TVL.

| KOL | Handle | Niche | Why |
|-----|--------|-------|-----|
| DeFi Mochi | @Defi_Mochi | Korean DeFi whales | Access to Korean capital. Drove huge Blast/EtherFi deposits. |
| The Abo Rosman | @theaborosman | Points meta | Consistently early on points plays, trusted by farmers. |
| Route2FI | @route2fi | FI + DeFi yield | Audience has real capital (not just gas-money farmers). |
| Hsaka | @HsakaTrades | CT whale | One tweet can move markets. Selective — only posts on conviction. |
| 0xHamz | @0xHamz | DeFi yield analysis | Deep quantitative analysis. His threads get bookmarked by whales. |

### Tier 3 — Legitimacy Signals (Not Paid KOLs)

Organic engagement from these people signals credibility more than any paid campaign:

| Person | Handle | Why |
|--------|--------|-----|
| Robert Leshner | @rleshner | Ex-Compound founder. A single retweet = institutional signal. |
| Stani Kulechov | @StaniKulechov | Aave founder. Engaging with mUSD = DeFi integration signal. |
| Hayden Adams | @haaborsman | Uniswap founder. Engagement = composability signal. |

### Engagement Approach

**❌ Do NOT**: Pay for generic "shill tweets" or scripted threads.

**✅ DO**:
1. Give KOLs **early access** with a boosted referral code (14-16% kickback)
2. Provide a **Dune dashboard link** so they screenshot real TVL growth (social proof)
3. Let them create **genuine content** — the Canton + RWA angle is novel enough to be interesting
4. Offer **advisory token allocation** (0.1-0.5% of supply) for Tier 1 KOLs who commit to 3+ months
5. Ship a **data pack**: yield comparisons, TVL charts, Merkle root screenshots for their threads
6. Invite to **private Telegram** with team — builds relationship, not transactional

### Budget

| Category | Amount | Notes |
|----------|--------|-------|
| Tier 1 KOL advisory allocations | 0.5% token supply | 5 KOLs × 0.1% each, 12-month vest |
| Tier 2 KOL referral boosts | $0 cash | Higher kickback (14%) is the incentive |
| Podcast sponsorships (Bankless, Unchained) | $15K-$30K | 1-2 episodes |
| Event sponsorships (ETHDenver, Token2049) | $10K-$25K | Side events + booth |
| **Total cash outlay** | **$25K-$55K** | Token allocations are non-cash |

---

## 9. Merkl & Points Platform Integration

### Merkl (by Angle Protocol)

**What**: The dominant incentive distribution platform for DEX LP incentives. Instead of bribing Curve gauges directly, you list campaigns on Merkl and LPs automatically earn rewards pro-rata.

**Integration Plan**:

1. Deploy a **mUSD/USDC pool on Curve** (or Uniswap V3 concentrated liquidity)
2. Create a **Merkl campaign** at [merkl.angle.money](https://merkl.angle.money)
3. Deposit MNTD tokens (or mUSD) as rewards — Merkl distributes pro-rata based on LP position range + time
4. LPs claim on the Merkl UI — no custom claiming contract needed
5. Every LP aggregator (DefiLlama, Beefy, Yearn) scrapes Merkl → your pool automatically appears with boosted APY

**Recommended Campaign**:

| Parameter | Value |
|-----------|-------|
| Pool | mUSD/USDC on Curve |
| Incentive budget | $50K-$200K in MNTD tokens |
| Duration | 3 months (S1 Genesis) |
| Target LP TVL | $5M-$25M |
| Platform fee | ~$0 (Merkl is free for campaigns) |

**Why Merkl over Curve bribes**: Merkl has better aggregator integration, supports concentrated liquidity positions, and doesn't require vote-locking CRV. More capital efficient.

### Points Platform Stack

| Platform | Purpose | Cost | Integration |
|----------|---------|------|-------------|
| **Galxe** | Social questing + onboarding | $500-$2K/campaign | Create quest campaigns: follow Twitter, join Discord, mint mUSD. Galxe distributes NFT badges. Top-of-funnel. |
| **Layer3** | On-chain questing | $1K-$5K/campaign | Create quests: "Mint 100+ mUSD" → earn Layer3 cubes + Minted points. Proves on-chain engagement. |
| **DeBank** | Social feed + portfolio | Free | List mUSD for portfolio tracking. Users see mUSD in their portfolio → organic social proof. |
| **Rabbithole** | On-chain education | $2K-$5K/campaign | "Learn and earn" — users complete mUSD tutorials, earn points. Great for onboarding non-DeFi users. |
| **QuestN** | Multi-chain questing | $500-$1K/campaign | Budget alternative to Galxe for smaller campaigns. |
| **Zealy** | Discord community quests | Free tier available | Internal community engagement — reward Discord activity with Minted points. |

### Recommended Stack (Priority Order)

1. **Merkl** → LP incentives (Curve/Uni pools) — *growth engine*
2. **Galxe** → Social + onboarding quests — *top-of-funnel*
3. **Your own Points API** (now live) → core loyalty — *retention layer*
4. **Layer3** → On-chain quests — *activation layer*
5. **Dune Dashboard** → transparency + CT content fuel — *trust layer*

### Integration Timeline

| Week | Platform | Action |
|------|----------|--------|
| Week 1 | Points API | Already live (`/api/points`, `/api/leaderboard`, etc.) |
| Week 2 | Galxe | Launch "Join Minted" quest (follow + join + connect wallet) |
| Week 3 | Dune | Publish dashboard with testnet data |
| Week 4 | Layer3 | Launch "First Mint" quest (mint 100 mUSD on testnet) |
| Month 2 | Merkl | Launch mUSD/USDC Curve pool campaign |
| Month 2 | DeBank | Submit mUSD for portfolio listing |

---

## 10. Dune Dashboard & Transparency

### Dashboard Queries

Seven SQL queries are implemented in [`points/src/dune.ts`](../points/src/dune.ts) and ready to deploy to Dune Analytics:

| Query | What It Shows |
|-------|---------------|
| **mUSD Supply & Minting** | Total supply over time, daily mint/burn volume |
| **smUSD Staking Activity** | ERC-4626 deposits/withdrawals, net flow, unique depositors |
| **Borrow & Liquidation Activity** | Outstanding debt, daily borrows/repays, liquidation events |
| **Collateral Deposits by Token** | TVL breakdown by collateral type |
| **Bridge Activity (Canton ↔ ETH)** | Cross-chain volume, rate limit utilization |
| **Top 100 mUSD Holders** | Whale watch, holder distribution |
| **Treasury Strategy Performance** | Yield generated, protocol fees, net yield to stakers |

### Automated CSV Upload

The points service can automatically upload daily snapshots to Dune via their CSV Upload API:

```
POST https://api.dune.com/api/v1/table/upload/csv
Header: X-Dune-API-Key: <DUNE_API_KEY>
Table: minted_points_snapshots
```

This enables anyone to query point balances directly on Dune, creating a public audit trail.

### Merkle Root Transparency

Every daily snapshot produces:
- **CSV file**: Full point breakdown per address (hold, stake, mint, collateral, referral, tier)
- **Merkle root**: `keccak256(abi.encodePacked(address, totalPoints, snapshotId))` — sorted pairs
- **Manifest**: Links CSV hash + Merkle root + block number + timestamp
- **Proof endpoint**: `GET /api/snapshot/proof/:address` returns Merkle proof for any user

Users can independently verify their point balance against the published Merkle root — no trust required.

---

## 11. Public API & Aggregator Access

### Base URL

```
https://api.minted.finance/   (production)
http://localhost:3210/          (development)
```

### Endpoint Reference

| Method | Path | Description | Rate Limit |
|--------|------|-------------|------------|
| GET | `/api/points/:address` | User points + tier + breakdown + referral info | 60/min |
| GET | `/api/leaderboard?limit=100` | Top N users (max 500) | 60/min |
| GET | `/api/season` | Current season info | 60/min |
| GET | `/api/seasons` | All seasons | 60/min |
| GET | `/api/stats/:seasonId` | Season-level aggregate stats | 60/min |
| GET | `/api/apy/scenarios` | Implied APY with tokenomics assumptions | 60/min |
| GET | `/api/referral/validate/:code` | Validate referral code | 60/min |
| GET | `/api/referral/stats/:address` | User's referral stats | 60/min |
| GET | `/api/referral/tree/:address` | User's full referral tree | 60/min |
| GET | `/api/referral/metrics` | Global viral coefficient | 60/min |
| POST | `/api/referral/create` | Create referral code | Auth |
| POST | `/api/referral/link` | Link referee to code | Auth |
| GET | `/api/snapshot/latest` | Latest transparency manifest | 60/min |
| GET | `/api/snapshot/history` | All snapshot manifests | 60/min |
| GET | `/api/snapshot/proof/:address` | Merkle proof for user | 60/min |
| GET | `/api/snapshot/csv/:id` | Download CSV file | 60/min |
| GET | `/health` | Health check with uptime + stats | No limit |

### CORS

All origins allowed (for aggregator/frontend access). Rate limited to 60 requests/minute per IP.

### Aggregator Integration

The API is designed for consumption by:
- **DefiLlama** — TVL tracking via `/api/stats/:seasonId`
- **Dune** — CSV upload via `uploadToDune()` function
- **CoinGecko/CoinMarketCap** — Supply data via `/api/points` aggregate
- **Custom frontends** — Full point dashboard via all endpoints
- **Bots/scripts** — Automated monitoring via `/health`

---

## 12. Revenue Model

### Revenue Streams at Scale

| Stream | Rate | At $100M TVL | At $500M TVL | At $1B TVL |
|--------|------|-------------|-------------|-----------|
| Yield Spread (T-bill yield minus payout) | ~6% of TVL | $6M/yr | $30M/yr | $60M/yr |
| Canton App Rewards (90% to Minted) | Platform rev share | $500K/yr | $2.5M/yr | $5M/yr |
| Attestation Fees | 0.05% per attestation | $50K/yr | $250K/yr | $500K/yr |
| Mint/Redeem Fees | 0.1% | $100K/yr | $500K/yr | $1M/yr |
| DEX LP Fees (protocol-owned liquidity) | Variable | $200K/yr | $1M/yr | $2M/yr |
| **Total** | | **$6.85M/yr** | **$34.25M/yr** | **$68.5M/yr** |

### Revenue Distribution (Post-TGE)

| Recipient | Share | Notes |
|-----------|-------|-------|
| smUSD stakers | 70% | Real yield to stakers |
| Protocol treasury | 20% | Ops, development, audits |
| MNTD stakers | 10% | Governance token yield |

---

## 13. Launch Checklist

### Pre-Launch (T-4 weeks)

- [ ] Security audit published (GitHub + dedicated page)
- [ ] Bug bounty program live (Immunefi, $250K max)
- [ ] Points API deployed and tested on staging
- [ ] Referral system tested end-to-end
- [ ] Dune dashboard live with testnet data
- [ ] Landing page with deposit countdown
- [ ] KOL outreach completed (3+ Tier 1 confirmed)
- [ ] Galxe quest campaign configured
- [ ] Discord bot for point balance queries
- [ ] Legal review of terms of service

### Launch Day (T-0)

- [ ] Mainnet contracts deployed and verified on Etherscan
- [ ] Frontend pointed to mainnet
- [ ] Points API switched to mainnet RPCs
- [ ] First transparency snapshot generated
- [ ] Merkle root published
- [ ] KOL threads go live (coordinated)
- [ ] Galxe quest activated
- [ ] Rate limiting verified under load

### Post-Launch (T+1 week)

- [ ] Dune dashboard updated with mainnet data
- [ ] First CSV snapshot uploaded to Dune
- [ ] Merkl campaign created (mUSD/USDC Curve pool)
- [ ] Layer3 on-chain quest activated
- [ ] DeBank listing submitted
- [ ] TVL milestones tracked and shared on CT

---

## 14. Risk Factors

| Risk | Severity | Mitigation |
|------|----------|------------|
| Smart contract exploit | Critical | 3 audits completed, bug bounty, rate limits on bridge (50M daily cap) |
| Depeg event | High | Over-collateralization, instant USDC redemption, oracle circuit breakers |
| Regulatory action | High | Legal review, jurisdiction selection, compliance-first design |
| Points sybil farming | Medium | Anti-sybil detection, minimum deposit thresholds, referral cycle detection |
| KOL reputation risk | Medium | No paid shills — advisory allocations with vesting, genuine content only |
| Canton network downtime | Medium | Bridge rate limiter, Ethereum-side operations continue independently |
| Low organic demand post-airdrop | Medium | Revenue sharing to MNTD stakers creates ongoing yield, Merkl LP incentives |
| Competitor launch (similar product) | Low | First-mover on Canton, integrated borrowing is defensible moat |

---

## Appendix A: Technical Infrastructure

| Component | Location | Status |
|-----------|----------|--------|
| Solidity contracts (14+) | `contracts/` | ✅ Audited, 950 tests passing |
| DAML modules (13) | `daml/` | ✅ Canton integration complete |
| Points API server | `points/src/server.ts` | ✅ Built, typechecks clean |
| Referral system | `points/src/referral.ts` | ✅ Built, typechecks clean |
| Transparency snapshots | `points/src/transparency.ts` | ✅ Built, typechecks clean |
| Dune queries + CSV upload | `points/src/dune.ts` | ✅ Built, typechecks clean |
| Frontend (Next.js 14) | `frontend/` | ✅ Points page, stake page, revenue model |
| Relay service | `relay/` | ✅ Canton ↔ ETH bridge relay |
| Bot service | `bot/` | ✅ Automated operations |

## Appendix B: Key Commits

| Commit | Description |
|--------|-------------|
| `1663dc8` | Critical audit findings fixed |
| `20fadcb` | High-severity findings fixed |
| `1701129` | Medium-severity findings fixed |
| `e4ac847` | Codex P1/P2 findings fixed |
| `d1794b6` | GTM infrastructure: referral system, public API, Dune dashboard, transparency snapshots |

---

*Document maintained by the Minted Protocol team. Last updated: February 12, 2026.*
