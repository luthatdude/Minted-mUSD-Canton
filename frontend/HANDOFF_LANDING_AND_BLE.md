# Designer / Developer Handoff — Minted Landing Page & BLE Page

> **Date:** 2026-02-11
> **Status:** Ready for implementation — neither page exists in code yet
> **Stack:** Next.js · React 18 · Tailwind CSS · THREE.js · TypeScript
> **Repo:** `frontend/src/`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Page 1 — Main Minted Landing](#2-page-1--main-minted-landing)
3. [Page 2 — BLE Page](#3-page-2--ble-page)
4. [Implementation Checklist](#4-implementation-checklist)

---

## 1. Architecture Overview

### What Exists Today

| File | What it is | Relationship |
|------|-----------|-------------|
| `src/components/LandingPage.tsx` | **mUSD app** cinematic entry (THREE.js + "Enter App") | This is Page 0 of the dApp — NOT the parent site |
| `src/pages/index.tsx` | SPA shell — renders LandingPage → then App | Current entry point |
| `src/components/Layout.tsx` | App shell (Navbar, footer, background gradients) | Used after "Enter App" |
| `src/components/Navbar.tsx` | Full app navbar (Dashboard, Stake, Borrow…) | Not used on landing/BLE |

### What Needs to Be Built

```
minted.app (NEW)                    ← Main Minted Landing Page
  ├─ → mUSD app (EXISTING)         ← Current LandingPage.tsx → index.tsx
  └─ → /ble (NEW)                  ← BLE Explainer Page
```

**Routing strategy (choose one):**

| Option | Approach |
|--------|----------|
| A — Subdomain | `minted.app` = landing, `app.minted.app` = dApp, `minted.app/ble` = BLE |
| B — Next.js routes | `pages/index.tsx` = landing, `pages/app.tsx` = dApp, `pages/ble.tsx` = BLE |
| C — SPA state | Current `index.tsx` adds a `view` state: `"landing"` → `"ble"` → `"app"` |

**Recommendation:** Option B (Next.js routes) — cleanest separation, SEO-friendly, each page is independently loadable.

### Files to Create

```
src/pages/index.tsx          ← REPLACE: becomes the Minted.app landing (currently the dApp)
src/pages/app.tsx            ← NEW: move current dApp entry here
src/pages/ble.tsx            ← NEW: BLE explainer page
src/components/MintedLanding.tsx   ← NEW: main landing component
src/components/BLEPage.tsx         ← NEW: BLE page component
```

---

## 2. Page 1 — Main Minted Landing

### Purpose

Full-screen immersive brand page. Introduces Minted, delivers the ownership thesis, funnels users to **mUSD** or **BLE**. This is NOT the dApp — no wallet connect, no chain toggle, no nav tabs.

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  FULL-VIEWPORT THREE.js MOTION ART BACKGROUND              │
│                                                             │
│  ┌─ NAV ──────────────────────────────────────────────────┐ │
│  │  [Logo] Minted                                         │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ HERO HEADLINE (center, vertically) ───────────────────┐ │
│  │                                                         │ │
│  │  "The Ownership Abstraction Layer                       │ │
│  │   For On Chain Economies,                               │ │
│  │   Powered by mUSD"                                      │ │
│  │                                                         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ BODY COPY ────────────────────────────────────────────┐ │
│  │  "The bifurcation between utility and equity…"          │ │
│  │  (4 paragraphs — see exact copy below)                  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ TWO PRODUCT CARDS (side by side) ─────────────────────┐ │
│  │  ┌──────────────┐         ┌──────────────────────────┐  │ │
│  │  │    mUSD      │         │  Beneficiary Locked      │  │ │
│  │  │  → Enter App │         │  Environment             │  │ │
│  │  │              │         │  → Learn More            │  │ │
│  │  └──────────────┘         └──────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Section-by-Section Spec

#### 2.1 THREE.js Background

Re-use the existing particle system from `LandingPage.tsx` (the `useThreeScene` hook, lines 24–273). It already implements everything needed:

| Feature | Implementation | Reference |
|---------|---------------|-----------|
| 2000 particles, spherical distribution | `PARTICLE_COUNT = 2000`, `radius = 3 + Math.random() * 6` | LandingPage.tsx L44–81 |
| 5-color palette | existing palette from LandingPage.tsx | L50–56 |
| Custom glow shader | `ShaderMaterial` with additive blending | L85–109 |
| Central fresnel orb | `SphereGeometry(0.5, 64, 64)` with pulsing shader | L113–151 |
| 3 orbiting torus rings | radii 1.2, 1.8, 2.5 | L154–170 |
| Neural connection lines | 300 max connections, distance < 1.5 | L173–185 |
| Mouse-follow camera | smooth lerp, `0.02` factor | L188–200 |
| Dark vignette overlay | radial gradient for text legibility | L296–302 |

**Change from existing:** The parent landing page should feel even MORE immersive. Consider:
- Increasing particle count to 3000
- Slower camera follow (0.01 factor) for dreamier feel
- Slightly brighter connection lines (opacity 0.1 instead of 0.06)

#### 2.2 Navigation

**Layout:** Logo left-aligned, nothing else. No "Enter App" button in the nav — the product cards below are the only exits.

**Key difference from mUSD landing:** Logo says "Minted" only (not "Minted Protocol"). No button on the right.

#### 2.3 Headline — EXACT COPY (verbatim, do not change)

> **"The Ownership Abstraction Layer For On Chain Economies, Powered by mUSD"**

"Powered by mUSD" should be visually emphasized (e.g. gradient or highlight treatment).

#### 2.4 Body Copy — EXACT COPY (verbatim, do not change)

> The bifurcation between utility and equity has been an insurmountable issue in Web3. Until now.
>
> Our first mover, compliant, technology acts as the fundamental bridge between these 2 worlds.
>
> Our "Beneficiary Locked Environment" was built as a modular primitive to not only allow token holders access to intrinsic value like equity, revenue share, and acquisition rights, but it also allows institutional grade assets access to composable decentralized finance through our stable coin mUSD on Canton Network.
>
> We're reshaping what ownership means in Web3.

"Beneficiary Locked Environment" should be visually emphasized (bold or highlight).

#### 2.5 Two Product Cards

Two large, visually striking cards. Side-by-side on desktop, stacked on mobile.

| Card | Title | Subtitle | CTA | Destination |
|------|-------|----------|-----|-------------|
| Left | **mUSD** | The Institutional Ownership Reserve Currency | → Enter App | `/app` (the dApp) |
| Right | **Beneficiary Locked Environment** | Bridging utility and equity for Web3 | → Learn More | `/ble` |

**Card styling:**
- Glass card with backdrop blur (reuse existing `.card` class)
- On hover: border brightens, subtle glow, card lifts slightly
- Motion graphic or icon inside each card (animated)
- Minimum height ~200px, ~50% width each on desktop
- Mobile: full width, stacked vertically with 16px gap

**Interaction:**
- Entire card is clickable (not just CTA text)
- Hover state: card lifts slightly, border glow intensifies
- Click: navigates to `/app` or `/ble`

### Design Principles (Landing)

1. **Immersive** — brand experience, not a dashboard
2. **Motion-first** — THREE.js is the primary visual
3. **Two exits only** — mUSD or BLE, nothing else
4. **No app chrome** — no wallet, no chain toggle, no nav tabs
5. **Copy is verbatim** — headline and body above are FINAL

---

## 3. Page 2 — BLE Page

### Purpose

Long-form scroll explainer. Presents the problem with utility tokens → introduces BLE as the answer → explains the modular staking pool → closes with the Minted ethos. Content-driven, not an app.

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  ┌─ NAV ──────────────────────────────────────────────────┐ │
│  │  ← Back to Minted.app                    [Logo] Minted │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ═══ SECTION 1 — THE PROBLEM ═════════════════════════════  │
│                                                             │
│  Hero: "Forget everything you know about ownership in Web3" │
│  Sub: "Utility tokens lack intrinsic value…"                │
│                                                             │
│  ┌─ For Projects ──┐    ┌─ For Investors ─────────────────┐ │
│  │ • Speculation    │    │ • Illiquid speculation          │ │
│  │ • Regulatory     │    │ • No equity access              │ │
│  │ • Fragmented     │    │ • Nonsensical valuations        │ │
│  │ • No intrinsic   │    │                                 │ │
│  └──────────────────┘    └─────────────────────────────────┘ │
│                                                             │
│  ═══ SECTION 2 — THE ANSWER ══════════════════════════════  │
│                                                             │
│  "Minted bridges decentralization and material ownership…"  │
│                                                             │
│  ═══ SECTION 3 — HOW IT WORKS ════════════════════════════  │
│                                                             │
│  "A Modular Staking Pool…"                                  │
│  (2 paragraphs explaining BLE mechanics)                    │
│                                                             │
│  ═══ SECTION 4 — ETHOS ══════════════════════════════════   │
│                                                             │
│  (4 paragraphs — closing statement)                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Section-by-Section Spec

#### 3.1 Navigation

- Sticky nav bar at top with backdrop blur
- Left: "← Back to Minted.app" link
- Right: "Minted" logo/wordmark

#### 3.2 Section 1 — The Problem

**Hero headline — EXACT COPY:**
> "Forget everything you know about ownership in Web3"

**Sub-headline — EXACT COPY:**
> "Utility tokens lack intrinsic value because they have no equity, ownership, or fundamental link to company performance."

**Two Pain Point Cards (side by side):**

| Card | Title | Bullet Points |
|------|-------|--------------|
| Left | **For Projects** | • Pure speculation · • Regulatory uncertainty · • Fragmented markets · • No intrinsic value · • Price can never truly reflect organizational performance |
| Right | **For Investors** | • Illiquid token speculation divorced from performance · • No compliant access to equity upside · • Nonsensical valuations for companies earning revenue, lacking revenue, or network effects |

**Card styling:**
- Glass card (reuse existing `.card` class) with a warning/negative visual tint
- Icon at top: ⚠️ or relevant SVG
- Side by side on desktop, stacked on mobile

#### 3.3 Section 2 — The Answer

**Headline — EXACT COPY:**
> "Minted bridges decentralization and material ownership through a simple, compliant infrastructure, that unifies utility speculation with legally backed issuer material events tied to real valuations."

Key phrases to emphasize: "material ownership", "legally backed issuer material events".

**Visual treatment:** This section should feel like a turning point. Consider:
- Horizontal rule or decorative divider above
- Larger vertical padding for visual breathing room

#### 3.4 Section 3 — How It Works

**Sub-headline — EXACT COPY:**
> "A Modular Staking Pool that can be implemented within any Web3 environment."

**Body — EXACT COPY (2 paragraphs):**

> When project tokens deposit into the BLE, holders are recorded via a revolving smart contract registrar. SPV held equity is calculated according to circulating supply to produce NAV. Anyone staked in the BLE has direct exposure to corporate material events, this can include: Equity Beneficiary changes, Revenue Sharing, and Acquisition tag-a-long exposure. Holders in the BLE are only exposed to these events in this environment, and these events are issued at the issuer's discretion only.

> Users are NOT locked, and do not need to KYC to enter/exit the BLE to freely arbitrage against the company's NAV. It's only upon issuer execution of events will BLE stakers be given the opportunity for exposure, which requires KYC. Minted does not provide any "rights," "grants," or "contracting" of such events. They are deployed at the issuer's discretion who is in full control.

Key phrases to bold: "NOT locked", "Equity Beneficiary changes, Revenue Sharing, and Acquisition tag-a-long exposure".

**Optional visual:** A simplified flow diagram:
```
[Token Holders] → [BLE Staking Pool] → [Registrar] → [NAV Calculation]
                                                     ↓
                                            [Material Events]
                                            (Equity · Revenue · Acquisition)
```

#### 3.5 Section 4 — Ethos

**Body — EXACT COPY (4 paragraphs):**

> Tokens have always acted as representations of access, utility, or governance — but not as an access marker to actual equity. This has left founders and communities structurally divided: companies grow in value, but the token ecosystems surrounding them do not share in that growth.

> The Web3 world has lacked an infrastructure layer that can legally, programmatically, and safely distribute true ownership to the people who create the most value. Minted introduces the first solution that unifies utility speculation with real, legally backed intrinsic value.

> Through Minted's first mover BLE, every token holder can choose to remain in a freely tradable utility state or opt into a regulated Beneficiary State that confers full shareholder rights. This creates an entirely new model for global participation — one where communities aren't just supporters or traders, but actual owners.

> By merging permissionless blockchain markets with real-world equity frameworks, Minted redefines what a token can represent and unlocks a future where ownership is accessible, programmable, and borderless.

Key phrases to emphasize: "actual owners" (paragraph 3), "accessible, programmable, and borderless" (paragraph 4).

**Section treatment:** This is the emotional close. Consider:
- Decorative border-top divider
- Larger text for the final sentence
- Subtle fade-in animation as sections scroll into view

### Design Principles (BLE)

1. **Content-driven** — explainer, not an app
2. **Scroll narrative** — Problem → Answer → How → Ethos (top to bottom story)
3. **Copy is verbatim** — ALL text above is FINAL from the Notion spec
4. **No app functionality** — no wallet, no widgets, no chain toggle
5. **Back navigation** — always show a path back to `minted.app`

---

## 4. Implementation Checklist

### Phase 1 — Routing & Scaffolding

- [ ] Create `src/pages/app.tsx` — move current `index.tsx` dApp logic here
- [ ] Replace `src/pages/index.tsx` — new Minted.app landing (imports `MintedLanding`)
- [ ] Create `src/pages/ble.tsx` — BLE page (imports `BLEPage`)
- [ ] Create `src/components/MintedLanding.tsx` — main landing component
- [ ] Create `src/components/BLEPage.tsx` — BLE page component
- [ ] Update any internal links/buttons that reference `/` to point to `/app`

### Phase 2 — Main Landing

- [ ] Extract `useThreeScene` from `LandingPage.tsx` into `src/hooks/useThreeScene.ts` (shared)
- [ ] Build `MintedLanding.tsx` — nav (logo only), headline, body copy, two product cards
- [ ] Wire product cards: mUSD → `/app`, BLE → `/ble`
- [ ] Responsive: cards stack on mobile, side-by-side on `sm:`+
- [ ] Fade-in animation on mount (reuse existing `visible` state pattern from LandingPage.tsx)

### Phase 3 — BLE Page

- [ ] Build `BLEPage.tsx` — sticky nav with back link, 4 scroll sections
- [ ] Section 1: hero + sub-headline + two pain-point cards
- [ ] Section 2: single headline block with gradient emphasis
- [ ] Section 3: sub-headline + two body paragraphs
- [ ] Section 4: four ethos paragraphs
- [ ] Scroll-triggered fade-in for each section (Intersection Observer or `scroll-margin`)
- [ ] Optional: flow diagram between sections 3 and 4

### Phase 4 — Polish

- [ ] SEO: `<title>`, `<meta description>`, og:image for each page
- [ ] Performance: lazy-load THREE.js (dynamic import) — it's ~500KB
- [ ] Accessibility: semantic HTML (`<main>`, `<section>`, `<article>`), proper heading hierarchy
- [ ] Mobile QA: test all breakpoints, especially hero text sizing
- [ ] Dark vignette on landing must keep text legible at all viewport sizes

### Assets Needed

| Asset | Format | Notes |
|-------|--------|-------|
| Minted logo (icon only) | SVG | Currently inline SVG (dollar-sign coin) — confirm if final |
| Minted wordmark | SVG/font | Currently `<span>` text — confirm if custom logotype needed |
| Product card icons/illustrations | SVG or Lottie | mUSD icon + BLE icon for the two product cards |
| og:image for landing | PNG 1200×630 | Social share preview |
| og:image for BLE | PNG 1200×630 | Social share preview |

### Fonts

Currently using Tailwind defaults (system font stack). If a custom font is desired (e.g., Inter, Space Grotesk), add to `_document.tsx` via Google Fonts or self-hosted.

---

## Reference Files

| Document | Path | Contents |
|----------|------|----------|
| mUSD dApp handoff | `frontend/MUSD DESIGNER_HANDOFF.md` | All 6 dApp pages (667 lines) |
| Existing landing component | `frontend/src/components/LandingPage.tsx` | THREE.js scene + mUSD app entry |
| Tailwind config | `frontend/tailwind.config.js` | Design tokens, animations |
| Global CSS | `frontend/src/styles/globals.css` | Reusable component classes |
